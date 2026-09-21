import { describe, expect, it, vi } from "vitest";
import { MeetingAudioMixer } from "./audio-mixer.js";

// jsdom doesn't implement MediaStream at all. audio-mixer.js's addRemoteTrack
// and setMicTrack both do `new MediaStream([track])` for real (the fake
// AudioContext below only fakes the AudioContext methods, not MediaStream
// itself) — without this stub every test that reaches those lines throws
// "MediaStream is not defined".
class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
}
globalThis.MediaStream = FakeMediaStream;

function fakeTrack(id, { readyState = "live" } = {}) {
  const listeners = {};
  return {
    id,
    readyState,
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    _emit(type) {
      (listeners[type] || []).forEach((handler) => handler());
    },
    _setReadyState(state) {
      this.readyState = state;
    },
  };
}

function fakeStream(id) {
  const listeners = {};
  return {
    id,
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    _emit(type, detail) {
      (listeners[type] || []).forEach((handler) => handler(detail));
    },
  };
}

function fakeAudioContext() {
  const sourceNodes = [];
  const gainNodes = [];
  const context = {
    state: "running",
    currentTime: 0,
    createMediaStreamDestination: () => ({ stream: {} }),
    createMediaStreamSource: () => {
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      sourceNodes.push(node);
      return node;
    },
    createGain: () => {
      const node = {
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gainNodes.push(node);
      return node;
    },
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { context, sourceNodes, gainNodes };
}

function makeMixer(overrides = {}) {
  const { context, sourceNodes, gainNodes } = fakeAudioContext();
  let currentNow = 0;
  const mixer = new MeetingAudioMixer({
    audioContext: context,
    now: () => currentNow,
    log: () => {},
    ...overrides,
  });
  return { mixer, sourceNodes, gainNodes, advanceNow: (ms) => { currentNow += ms; } };
}

describe("MeetingAudioMixer remote sources", () => {
  it("connects a new remote track to the destination", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0].connect).toHaveBeenCalledTimes(1);
  });

  it("does not add a duplicate entry for the exact same track object", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("t1");
    const stream = fakeStream("s1");
    mixer.addRemoteTrack({ track, stream, mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track, stream, mid: null, connectionId: 1 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes).toHaveLength(1);
  });

  it("replaces the source when a new track arrives for the same connection+stream slot", () => {
    const { mixer, sourceNodes } = makeMixer();
    const stream = fakeStream("s1");
    const firstTrack = fakeTrack("t1");
    const secondTrack = fakeTrack("t2");
    mixer.addRemoteTrack({ track: firstTrack, stream, mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: secondTrack, stream, mid: null, connectionId: 1 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
  });

  it("ignores a late lifecycle event from a track that was already replaced", () => {
    // Regression test for a real bug Codex's review caught in an earlier version
    // of this plan: the old track's "ended"/"mute"/"unmute" listeners closed
    // over `key`, not over the specific track they were attached for — so a
    // late-firing event from the REPLACED track would incorrectly tear down or
    // stale-mark the NEW track's entry, since both live at the same key.
    const { mixer, sourceNodes } = makeMixer();
    const stream = fakeStream("s1");
    const firstTrack = fakeTrack("t1");
    const secondTrack = fakeTrack("t2");
    mixer.addRemoteTrack({ track: firstTrack, stream, mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: secondTrack, stream, mid: null, connectionId: 1 });

    firstTrack._emit("ended");
    firstTrack._emit("mute");

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();

    // The new (second) track's own events must still work normally.
    secondTrack._emit("ended");
    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("keeps sources from different connections separate even with the same stream id", () => {
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s1"), mid: null, connectionId: 2 });

    expect(mixer.activeRemoteSourceCount).toBe(2);
  });

  it("removes a source when its track fires ended", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._emit("ended");

    expect(mixer.activeRemoteSourceCount).toBe(0);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("removes a source when its stream fires removetrack for that track", () => {
    const { mixer } = makeMixer();
    const track = fakeTrack("t1");
    const stream = fakeStream("s1");
    mixer.addRemoteTrack({ track, stream, mid: null, connectionId: 1 });

    stream._emit("removetrack", { track });

    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("removes every source that belongs to a connection when removeConnection is called", () => {
    const { mixer, sourceNodes } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s2"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t3"), stream: fakeStream("s3"), mid: null, connectionId: 2 });

    mixer.removeConnection(1);

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[2].disconnect).not.toHaveBeenCalled();
  });

  it("reconcile purges a source whose track is no longer live, even if ended never fired", () => {
    const { mixer } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._setReadyState("ended");
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("reconcile does not purge a live, unmuted source", () => {
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });

    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(1);
  });

  it("reconcile purges a source that has been muted longer than the stale threshold", () => {
    const { mixer, advanceNow } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._emit("mute");
    advanceNow(16000);
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("reconcile does not purge a source that unmuted before the stale threshold", () => {
    const { mixer, advanceNow } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._emit("mute");
    advanceNow(1000);
    track._emit("unmute");
    advanceNow(16000);
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(1);
  });
});

describe("MeetingAudioMixer reconciliation scheduling", () => {
  it("starts and stops a periodic call to reconcile", () => {
    vi.useFakeTimers();
    try {
      const { mixer } = makeMixer();
      const reconcileSpy = vi.spyOn(mixer, "reconcile");

      mixer.startReconciliation(1000);
      vi.advanceTimersByTime(3500);
      expect(reconcileSpy).toHaveBeenCalledTimes(3);

      mixer.stopReconciliation();
      vi.advanceTimersByTime(5000);
      expect(reconcileSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calling startReconciliation twice does not schedule a second interval", () => {
    vi.useFakeTimers();
    try {
      const { mixer } = makeMixer();
      const reconcileSpy = vi.spyOn(mixer, "reconcile");

      mixer.startReconciliation(1000);
      mixer.startReconciliation(1000);
      vi.advanceTimersByTime(1000);

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MeetingAudioMixer mic lifecycle", () => {
  it("disconnects the previous mic chain when setMicTrack is called again", () => {
    const { mixer, sourceNodes, gainNodes } = makeMixer();
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });
    mixer.setMicTrack(fakeTrack("mic-2"), { initiallyMuted: false });

    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(gainNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
    expect(gainNodes[1].disconnect).not.toHaveBeenCalled();
  });

  it("does not throw when setMicTrack is called for the first time", () => {
    const { mixer } = makeMixer();
    expect(() => mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false })).not.toThrow();
  });
});
