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
    enabled: true,
    clone: vi.fn(function () { const copy = fakeTrack(`${id}-copy`, { readyState, channelCount }); copy.enabled = this.enabled; return copy; }),
    stop: vi.fn(),
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
  const analyserNodes = [];
  let destinationNode = null;
  const context = {
    state: "running",
    currentTime: 0,
    createMediaStreamDestination: () => {
      destinationNode = { stream: {} };
      return destinationNode;
    },
    createMediaStreamSource: (stream) => {
      const node = { stream, connect: vi.fn(), disconnect: vi.fn() };
      sourceNodes.push(node);
      return node;
    },
    createAnalyser: () => {
      const node = {
        fftSize: 2048, value: 0,
        getFloatTimeDomainData(samples) { samples.fill(this.value); },
        disconnect: vi.fn(),
      };
      analyserNodes.push(node);
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
  return { context, sourceNodes, gainNodes, analyserNodes, get destinationNode() { return destinationNode; } };
}

function makeMixer(overrides = {}) {
  const audioContextFake = fakeAudioContext();
  const { context, sourceNodes, gainNodes } = audioContextFake;
  let currentNow = 0;
  const mixer = new MeetingAudioMixer({ recordingType: "webrtc",
    audioContext: context,
    now: () => currentNow,
    log: () => {},
    ...overrides,
  });
  return {
    mixer,
    context,
    analyserNodes: audioContextFake.analyserNodes,
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

  it("keeps the remote audio node connected when a live track recovers after a long mute", () => {
    const { mixer, sourceNodes, advanceNow } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._emit("mute");
    advanceNow(60000);
    mixer.reconcile();
    track._emit("unmute");
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0].disconnect).not.toHaveBeenCalled();
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


describe("receiver sweep identity and remote analysis", () => {
  it("enriches a swept track with mid and stream without creating duplicate nodes", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("track");
    mixer.addRemoteTrack({ connectionId: 1, track });
    mixer.addRemoteTrack({ connectionId: 1, track, mid: "0" });
    const stream = fakeStream("stream");
    mixer.addRemoteTrack({ connectionId: 1, track, mid: "0", stream });
    mixer.addRemoteTrack({ connectionId: 1, track, mid: "0" });
    expect(sourceNodes).toHaveLength(1);
    expect([...mixer.remoteSources.keys()]).toEqual(["stream:stream"]);
    track._emit("mute");
    expect(mixer.remoteSources.get("stream:stream").staleSince).toBe(0);
    stream._emit("removetrack", { track });
    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("never resurrects a displaced track when an older receiver is swept again", () => {
    const { mixer, sourceNodes } = makeMixer();
    const stream = fakeStream("same");
    const old = fakeTrack("old");
    const current = fakeTrack("current");
    mixer.addRemoteTrack({ connectionId: 1, track: old, stream });
    mixer.addRemoteTrack({ connectionId: 2, track: current, stream });
    expect(mixer.addRemoteTrack({ connectionId: 1, track: old, stream })).toBe("superseded");
    old._emit("ended");
    mixer.removeConnection(1);
    expect(sourceNodes).toHaveLength(2);
    expect(mixer.remoteSources.get("stream:same").track).toBe(current);
  });

  it("retains the current source if connecting its replacement fails, then retries", () => {
    const { mixer, context } = makeMixer();
    const stream = fakeStream("same");
    const old = fakeTrack("old");
    const current = fakeTrack("current");
    mixer.addRemoteTrack({ connectionId: 1, track: old, stream });
    const create = context.createMediaStreamSource;
    context.createMediaStreamSource = () => { throw new Error("temporary"); };
    expect(() => mixer.addRemoteTrack({ connectionId: 2, track: current, stream })).toThrow("temporary");
    expect(mixer.remoteSources.get("stream:same").track).toBe(old);
    context.createMediaStreamSource = create;
    expect(mixer.addRemoteTrack({ connectionId: 2, track: current, stream })).toBe("added");
  });

  it("measures only remote samples and marks suspended measurements unavailable", () => {
    const { mixer, context, analyserNodes, advanceNow } = makeMixer();
    mixer.setMicTrack(fakeTrack("mic"), { initiallyMuted: false });
    mixer.addRemoteTrack({ connectionId: 1, track: fakeTrack("remote") });
    mixer.startRemoteAnalysis();
    mixer.sampleRemoteAudio();
    expect(analyserNodes).toHaveLength(1);
    expect(mixer.getRemoteAudioSnapshot()[0]).toMatchObject({ rms: 0, peak: 0, lastSignalAt: null });
    analyserNodes[0].value = 0.25;
    advanceNow(500);
    mixer.sampleRemoteAudio();
    expect(mixer.getRemoteAudioSnapshot()[0]).toMatchObject({ rms: 0.25, peak: 0.25, lastSignalAt: 500 });
    context.state = "suspended";
    // Snapshot must invalidate levels even before another timer tick.
    expect(mixer.getRemoteAudioSnapshot()[0]).toMatchObject({ rms: null, peak: null, lastSignalAt: 500 });
    mixer.sampleRemoteAudio();
    context.state = "running";
    expect(mixer.getRemoteAudioSnapshot()[0].rms).toBeNull();
    mixer.stopRemoteAnalysis();
    expect(analyserNodes[0].disconnect).toHaveBeenCalledOnce();
    mixer.startRemoteAnalysis();
    expect(mixer.getRemoteAudioSnapshot()[0].lastSignalAt).toBeNull();
    mixer.sampleRemoteAudio();
    expect(analyserNodes).toHaveLength(2);
  });

  it("keeps analysis failures out of the recording path and retries the analyser", () => {
    const { mixer, context, sourceNodes } = makeMixer();
    mixer.addRemoteTrack({ connectionId: 1, track: fakeTrack("remote") });
    const create = context.createAnalyser;
    context.createAnalyser = () => { throw new Error("analysis failed"); };
    mixer.startRemoteAnalysis();
    expect(mixer.sampleRemoteAudio()).toHaveLength(1);
    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[0].disconnect).not.toHaveBeenCalled();
    context.createAnalyser = create;
    expect(mixer.sampleRemoteAudio()).toEqual([]);
    expect(mixer.getRemoteAudioSnapshot()[0].rms).toBe(0);
  });
});


it("keeps the newer connection when late stream metadata identifies an older swept track", () => {
  const { mixer } = makeMixer();
  const older = fakeTrack("older");
  const newer = fakeTrack("newer");
  const stream = fakeStream("same");
  mixer.addRemoteTrack({ connectionId: 1, track: older, mid: "0" });
  mixer.addRemoteTrack({ connectionId: 2, track: newer, stream });
  expect(mixer.addRemoteTrack({ connectionId: 1, track: older, stream })).toBe("superseded");
  expect(mixer.activeRemoteSourceCount).toBe(1);
  expect(mixer.remoteSources.get("stream:same").track).toBe(newer);
});


describe("owned remote capture tracks", () => {
  it("records an enabled private clone even when Meet disabled its original", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("remote");
    track.enabled = false;
    mixer.addRemoteTrack({ connectionId: 1, track });
    const capture = sourceNodes[0].stream.tracks[0];
    expect(capture).not.toBe(track);
    expect(capture.enabled).toBe(true);
    expect(track.enabled).toBe(false);
    expect(mixer.getRemoteAudioSnapshot()[0]).toMatchObject({ enabled: false, captureEnabled: true, captureTrackId: capture.id });
    mixer.removeConnection(1);
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("isolates later enabled changes and does not clone again on repeated sweeps", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("remote");
    mixer.addRemoteTrack({ connectionId: 1, track });
    track.enabled = false;
    mixer.addRemoteTrack({ connectionId: 1, track });
    expect(track.clone).toHaveBeenCalledOnce();
    expect(sourceNodes[0].stream.tracks[0].enabled).toBe(true);
    expect(track.enabled).toBe(false);
  });

  it("stops a failed new clone while preserving the current source for retry", () => {
    const { mixer, context, sourceNodes } = makeMixer();
    const stream = fakeStream("same");
    const old = fakeTrack("old");
    const next = fakeTrack("next");
    mixer.addRemoteTrack({ connectionId: 1, track: old, stream });
    const create = context.createMediaStreamSource;
    context.createMediaStreamSource = () => { throw new Error("temporary"); };
    expect(() => mixer.addRemoteTrack({ connectionId: 2, track: next, stream })).toThrow("temporary");
    expect(next.clone.mock.results[0].value.stop).toHaveBeenCalledOnce();
    expect(sourceNodes[0].stream.tracks[0].stop).not.toHaveBeenCalled();
    context.createMediaStreamSource = create;
    mixer.addRemoteTrack({ connectionId: 2, track: next, stream });
    expect(sourceNodes[0].stream.tracks[0].stop).toHaveBeenCalledOnce();
    expect(next.clone).toHaveBeenCalledTimes(2);
    expect(old.stop).not.toHaveBeenCalled();
    expect(next.stop).not.toHaveBeenCalled();
  });

  it("releases only owned clones when the mixer closes", async () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("remote");
    mixer.addRemoteTrack({ connectionId: 1, track });
    await mixer.close();
    expect(sourceNodes[0].stream.tracks[0].stop).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    expect(mixer.activeRemoteSourceCount).toBe(0);
  });
});


describe("hybrid capture routes", () => {
  it("mixes distinct HTML, Web Audio and local sources without global switching", () => {
    const { mixer, sourceNodes } = makeMixer();
    mixer.recordingType = "hybrid";
    const remote = fakeTrack("remote");
    mixer.addRemoteTrack({ connectionId: 1, track: remote });
    expect(mixer.getRemoteAudioSnapshot()[0].connectedToMixer).toBe(false);
    const stream = { id: "html", getAudioTracks: () => [remote] };
    mixer.addHtmlStream(stream); mixer.addHtmlStream(stream);
    mixer.addPlaybackStream("page", {}); mixer.addPlaybackStream("page", {});
    expect(mixer.htmlSources.size).toBe(1);
    expect(mixer.playbackSources.size).toBe(1);
    expect(sourceNodes).toHaveLength(3);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
    mixer.addRemoteTrack({ connectionId: 1, track: remote, discovery: "sweep" });
    expect(mixer.getRemoteAudioSnapshot()[0].connectedToMixer).toBe(true);
    mixer.removePlaybackStream("page");
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
  });
  it("keeps a stream represented once when HTML and receivers share its identity", () => {
    const { mixer } = makeMixer(); mixer.recordingType = "hybrid";
    const track = fakeTrack("remote"), stream = fakeStream("same");
    mixer.addRemoteTrack({ connectionId: 1, track, stream });
    mixer.addHtmlStream(stream);
    mixer.addRemoteTrack({ connectionId: 1, track, stream, discovery: "sweep" });
    expect(mixer.getRemoteAudioSnapshot()[0].connectedToMixer).toBe(false);
    expect(mixer.htmlSources.size).toBe(1);
  });
});

it("keeps HTML and Web Audio confined to their internal capture modes", () => {
  const { mixer } = makeMixer();
  const stream = { id: "html" };
  mixer.addHtmlStream(stream); mixer.addPlaybackStream("output", {});
  expect(mixer.htmlSources.size).toBe(0); expect(mixer.playbackSources.size).toBe(0);
  mixer.recordingType = "html";
  mixer.addHtmlStream(stream); mixer.addPlaybackStream("output", {});
  expect(mixer.htmlSources.size).toBe(1); expect(mixer.playbackSources.size).toBe(0);
  mixer.recordingType = "hybrid";
  mixer.addPlaybackStream("output", {});
  expect(mixer.htmlSources.size).toBe(1); expect(mixer.playbackSources.size).toBe(1);
});

it("recreates a suspect HTML source while preserving owners and remote tracks", () => {
  const { mixer, sourceNodes } = makeMixer(); mixer.recordingType = "hybrid";
  const track = fakeTrack("suspect"), stream = fakeStream("shared");
  mixer.addRemoteTrack({ connectionId: 1, track, stream }); mixer.addHtmlStream(stream);
  expect(mixer.reconnectRemoteStream("stream:shared")).toBe(true);
  expect(sourceNodes[1].disconnect).toHaveBeenCalledOnce();
  expect(mixer.htmlSources.get("shared")).toBe(sourceNodes[2]);
  expect(track.stop).not.toHaveBeenCalled(); expect(mixer.htmlSources.size).toBe(1);
});

describe("sender ownership", () => {
  it("retires a replaced live track only when the last sender releases it", async () => {
    const { mixer } = makeMixer(); const old = { ...fakeTrack("old"), kind: "audio" }, next = { ...fakeTrack("next"), kind: "audio" };
    const a = {}, b = {}; mixer.setLocalSender(a, old, 1); mixer.setLocalSender(b, old, 2);
    expect(mixer.localSources.size).toBe(1);
    mixer.setLocalSender(a, next); expect(mixer.localSources.size).toBe(2);
    mixer.setLocalSender(b, null); expect([...mixer.localSources.keys()]).toEqual(["next"]);
    expect(old.stop).not.toHaveBeenCalled(); mixer.removeConnection(1); expect(mixer.localSources.size).toBe(0); await mixer.close();
  });
  it("reconciles removed senders while retaining ownership in other connections", async () => {
    const { mixer } = makeMixer(); const track = { ...fakeTrack("shared"), kind: "audio" }; const a = {}, b = {};
    mixer.setLocalSender(a, track, 1); mixer.setLocalSender(b, track, 2);
    mixer.reconcileLocalOwners(1, []); expect(mixer.localSources.size).toBe(1);
    mixer.reconcileLocalOwners(2, []); expect(mixer.localSources.size).toBe(0); await mixer.close();
  });
});

describe("common receiver reconciliation phase", () => {
  it("connects a pending event source without another track event and isolates incorporation errors", () => {
    const { mixer } = makeMixer({ recordingType: "hybrid" });
    const one = fakeTrack("one"), two = fakeTrack("two");
    mixer.addRemoteTrack({ connectionId: 1, track: one }); mixer.addRemoteTrack({ connectionId: 2, track: two });
    const first = mixer.remoteSources.get("conn:1:track:one"); first.sourceNode.connect.mockImplementationOnce(() => { throw new Error("temporary"); });
    expect(mixer.reconcileRemoteSources()).toMatchObject({ recovered: 1, errors: [{ message: "temporary" }] });
    expect(mixer.reconcileRemoteSources()).toMatchObject({ recovered: 1, errors: [] });
    expect(mixer.reconcileRemoteSources().recovered).toBe(0);
  });
  it("defers unavailable sources and failed connections, then reconnects their pending sources", () => {
    const { mixer } = makeMixer({ recordingType: "hybrid" }); const track = fakeTrack("remote"); track.muted = true;
    mixer.addRemoteTrack({ connectionId: 1, track, discovery: "sweep", deferConnection: true });
    expect(mixer.reconcileRemoteSources().recovered).toBe(0);
    track.muted = false; track.enabled = false; expect(mixer.reconcileRemoteSources().recovered).toBe(0);
    track.enabled = true; mixer.connectionStates.set(1, "failed"); expect(mixer.reconcileRemoteSources().recovered).toBe(0);
    mixer.connectionStates.set(1, "connected"); expect(mixer.reconcileRemoteSources().recovered).toBe(1);
  });
});

it("keeps the HTML mode isolated from receiver and Web Audio inputs", () => {
  const { mixer } = makeMixer({ recordingType: "html" }); const track = fakeTrack("receiver"), stream = fakeStream("html");
  mixer.addRemoteTrack({ connectionId: 1, track, stream, discovery: "sweep" });
  expect(mixer.getRemoteAudioSnapshot()[0].connectedToMixer).toBe(false);
  mixer.reconcileRemoteSources(); expect(mixer.getRemoteAudioSnapshot()[0].connectedToMixer).toBe(false);
  mixer.addHtmlStream(stream); expect(mixer.htmlSources.size).toBe(1);
});

it("applies the initial mute immediately before any recorded frames", () => {
  const { mixer, gainNodes } = makeMixer(); mixer.addLocalTrack(fakeTrack("mic"));
  mixer.setMicMuted(true, { immediate: true });
  expect(gainNodes[0].gain.value).toBe(0);
  expect(gainNodes[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
});
