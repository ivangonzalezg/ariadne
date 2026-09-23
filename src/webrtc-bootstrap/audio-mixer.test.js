import { describe, expect, it, vi } from "vitest";
import { MeetingAudioMixer } from "./audio-mixer.js";

// jsdom doesn't implement MediaStream at all. audio-mixer.js's addRemoteTrack
// and setMicTrack both do `new MediaStream([track])` for real (the fake
// AudioContext below only fakes the AudioContext methods, not MediaStream
// itself) - without this stub every test that reaches those lines throws
// "MediaStream is not defined".
class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
}
globalThis.MediaStream = FakeMediaStream;

function fakeTrack(id, { readyState = "live", channelCount = null } = {}) {
  const listeners = {};
  return {
    id,
    readyState,
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    getSettings() {
      return { channelCount };
    },
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
  let destinationNode = null;
  const context = {
    state: "running",
    currentTime: 0,
    createMediaStreamDestination: () => {
      destinationNode = { stream: {} };
      return destinationNode;
    },
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
  return { context, sourceNodes, gainNodes, get destinationNode() { return destinationNode; } };
}

function makeMixer(overrides = {}) {
  const audioContextFake = fakeAudioContext();
  const { context, sourceNodes, gainNodes } = audioContextFake;
  let currentNow = 0;
  const mixer = new MeetingAudioMixer({
    audioContext: context,
    now: () => currentNow,
    log: () => {},
    ...overrides,
  });
  return {
    mixer,
    sourceNodes,
    gainNodes,
    destinationNode: audioContextFake.destinationNode,
    advanceNow: (ms) => { currentNow += ms; },
  };
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
    // over `key`, not over the specific track they were attached for - so a
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

  it("treats the same stream id as the same logical source across different connections (replaces, not duplicates)", () => {
    // This is the targeted hypothesis for the echo the user confirmed via an A/B
    // recording against a comparable extension (not yet confirmed as THE cause against a real
    // Meet call - see Task 2's logging and Task 3's manual verification for how
    // that gets confirmed or ruled out): IF Google Meet reuses the same
    // MediaStream.id for a participant across a connection replacement (new
    // RTCPeerConnection, new connectionId), the old and new copies must not both
    // stay connected to the mix - that would produce an audible doubling.
    const { mixer, sourceNodes } = makeMixer();
    const firstTrack = fakeTrack("t1");
    const secondTrack = fakeTrack("t2");
    mixer.addRemoteTrack({ track: firstTrack, stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: secondTrack, stream: fakeStream("s1"), mid: null, connectionId: 2 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
  });

  it("does not remove a replaced source when its OLD connection later closes, and the replacement stays removable under its real owner", () => {
    // Locks in that connectionKeys bookkeeping still follows the entry's actual
    // owning connection (tracked separately from the key string itself), not the
    // connection that originally created the key - both directions: closing the
    // OLD connection must not touch the replacement, and closing the NEW
    // (actual owning) connection must still clean it up correctly.
    const { mixer, sourceNodes } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s1"), mid: null, connectionId: 2 });

    mixer.removeConnection(1);
    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();

    mixer.removeConnection(2);
    expect(mixer.activeRemoteSourceCount).toBe(0);
    expect(sourceNodes[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps sources from different connections separate when falling back to mid (no stream), even with the same mid", () => {
    // mid ("0", "1", ...) is a per-connection SDP media-line id, not globally
    // unique - unlike stream.id, it's NOT safe to treat as the same logical
    // source across connections. This test locks in that the mid fallback stays
    // connection-scoped.
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: null, mid: "0", connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: null, mid: "0", connectionId: 2 });

    expect(mixer.activeRemoteSourceCount).toBe(2);
  });

  it("does NOT migrate an entry from a mid-fallback key to a stream key if a stream becomes available later on the same connection+mid (known, accepted gap)", () => {
    // There is no alias/migration mechanism between the two keying schemes. If a
    // track first arrives with no stream (falls back to conn:<id>:mid:<mid>) and
    // a later track for the same connection+mid DOES have a stream (keys as
    // stream:<id>), they're treated as two unrelated sources, not one - this
    // test documents that as a known, deliberately-accepted gap (Codex's review
    // flagged it as an untested risk; YAGNI applies until real evidence from the
    // Task 2 diagnostic logging shows this transition actually happens against a
    // real Meet call and causes a problem worth fixing).
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: null, mid: "0", connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s1"), mid: "0", connectionId: 1 });

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

describe("MeetingAudioMixer channel configuration", () => {
  it("forces the destination node to explicit stereo", () => {
    const { destinationNode } = makeMixer();
    expect(destinationNode.channelCount).toBe(2);
    expect(destinationNode.channelCountMode).toBe("explicit");
    expect(destinationNode.channelInterpretation).toBe("speakers");
  });

  it("forces the mic gain node to explicit stereo so a mono mic up-mixes to both channels", () => {
    const { mixer, gainNodes } = makeMixer();
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });

    expect(gainNodes[0].channelCount).toBe(2);
    expect(gainNodes[0].channelCountMode).toBe("explicit");
    expect(gainNodes[0].channelInterpretation).toBe("speakers");
  });

  it("re-applies explicit stereo to the new mic gain node when setMicTrack is called again", () => {
    const { mixer, gainNodes } = makeMixer();
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });
    mixer.setMicTrack(fakeTrack("mic-2"), { initiallyMuted: false });

    expect(gainNodes[1].channelCount).toBe(2);
    expect(gainNodes[1].channelCountMode).toBe("explicit");
    expect(gainNodes[1].channelInterpretation).toBe("speakers");
  });

  it("logs the destination's channel configuration before and after forcing it to stereo", () => {
    const logs = [];
    makeMixer({ log: (event, details) => logs.push({ event, details }) });

    expect(logs).toContainEqual({
      event: "mixer-channel-config-before",
      details: { node: "destination", channelCount: undefined, channelCountMode: undefined, channelInterpretation: undefined },
    });
    expect(logs).toContainEqual({ event: "mixer-channel-config-after", details: { node: "destination", channelCount: 2 } });
  });

  it("logs the mic track's own reported channel count separately from the gain node's forced config", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    mixer.setMicTrack(fakeTrack("mic-1", { channelCount: 2 }), { initiallyMuted: false });

    expect(logs).toContainEqual({ event: "mic-track-settings", details: { trackId: "mic-1", channelCount: 2 } });
    expect(logs).toContainEqual({ event: "mixer-channel-config-after", details: { node: "micGainNode", channelCount: 2 } });
  });

  it("logs the mic gain node's channel configuration before forcing it to stereo, same as the destination", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });

    expect(logs).toContainEqual({
      event: "mixer-channel-config-before",
      details: { node: "micGainNode", channelCount: undefined, channelCountMode: undefined, channelInterpretation: undefined },
    });
  });

  it("logs a null channelCount when the mic track has no getSettings method at all", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    const trackWithoutGetSettings = fakeTrack("mic-1");
    delete trackWithoutGetSettings.getSettings;

    mixer.setMicTrack(trackWithoutGetSettings, { initiallyMuted: false });

    expect(logs).toContainEqual({ event: "mic-track-settings", details: { trackId: "mic-1", channelCount: null } });
  });

  it("logs a null channelCount when getSettings exists but returns undefined", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    const trackWithEmptySettings = fakeTrack("mic-1");
    trackWithEmptySettings.getSettings = () => undefined;

    mixer.setMicTrack(trackWithEmptySettings, { initiallyMuted: false });

    expect(logs).toContainEqual({ event: "mic-track-settings", details: { trackId: "mic-1", channelCount: null } });
  });
});
