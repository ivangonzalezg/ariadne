import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakePeerConnection {
  constructor() {
    this.connectionState = "new";
    this._listeners = {};
    this._senders = [];
    this._receivers = [];
    this._transceivers = [];
  }
  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }
  _emit(type, eventLike) {
    (this._listeners[type] || []).forEach((handler) => handler(eventLike));
  }
  _setConnectionState(state) {
    this.connectionState = state;
    this._emit("connectionstatechange");
  }
  getReceivers() { return this._receivers; }
  getTransceivers() { return this._transceivers; }
  getSenders() {
    return this._senders;
  }
  _setSenders(senders) {
    this._senders = senders;
  }
}

function fakeAudioTrack(id) {
  return { kind: "audio", id, enabled: true, clone() { return { kind: "audio", id: `${id}-copy`, enabled: this.enabled, stop: vi.fn() }; } };
}

let originalRTCPeerConnection;

beforeEach(() => {
  originalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = FakePeerConnection;
});

afterEach(() => {
  window.RTCPeerConnection = originalRTCPeerConnection;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("installRtcPatch", () => {
  it("increments diagnostics.peerConnectionsCreated for each new connection", async () => {
    vi.resetModules();
    const { installRtcPatch, diagnostics } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    new window.RTCPeerConnection();
    new window.RTCPeerConnection();
    expect(diagnostics.peerConnectionsCreated).toBe(2);
  });

  it("calls onRemoteAudioTrack with track, stream, mid and a connectionId for an audio track event", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    const track = fakeAudioTrack("track-1");
    const stream = { id: "stream-1" };
    pc._emit("track", { track, streams: [stream], transceiver: { mid: "0" } });

    expect(onRemoteAudioTrack).toHaveBeenCalledTimes(1);
    const payload = onRemoteAudioTrack.mock.calls[0][0];
    expect(payload.track).toBe(track);
    expect(payload.stream).toBe(stream);
    expect(payload.mid).toBe("0");
    expect(typeof payload.connectionId).toBe("number");
  });

  it("ignores non-audio tracks", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc._emit("track", { track: { kind: "video", id: "v1" }, streams: [], transceiver: null });
    expect(onRemoteAudioTrack).not.toHaveBeenCalled();
  });

  it("ignores a track event when the connection is already closed, but still logs it for diagnostics", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    const logs = [];
    installRtcPatch({
      onRemoteAudioTrack,
      onConnectionClosed: () => {},
      log: (event, details) => logs.push({ event, details }),
    });
    const pc = new window.RTCPeerConnection();
    pc.connectionState = "closed";
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });

    expect(onRemoteAudioTrack).not.toHaveBeenCalled();
    expect(logs).toContainEqual({
      event: "remote-track-observed",
      details: { connectionId: expect.any(Number), connectionState: "closed", streamId: null, mid: null, trackId: "t1" },
    });
  });

  it("passes null for stream/mid when the track event has neither", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    const payload = onRemoteAudioTrack.mock.calls[0][0];
    expect(payload.stream).toBeNull();
    expect(payload.mid).toBeNull();
  });

  it("calls onConnectionClosed with the same connectionId the track events used, when the connection closes", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    const onConnectionClosed = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed });
    const pc = new window.RTCPeerConnection();
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    const { connectionId } = onRemoteAudioTrack.mock.calls[0][0];

    pc._setConnectionState("closed");

    expect(onConnectionClosed).toHaveBeenCalledWith(connectionId);
  });

  it("only cleans up a failed connection when it actually closes", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onConnectionClosed = vi.fn();
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed });
    const pc = new window.RTCPeerConnection();
    pc._setConnectionState("failed");
    expect(onConnectionClosed).not.toHaveBeenCalled();
    pc._setConnectionState("closed");
    expect(onConnectionClosed).toHaveBeenCalledTimes(1);
  });

  it("does not call onConnectionClosed for other connection states", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onConnectionClosed = vi.fn();
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed });
    const pc = new window.RTCPeerConnection();
    pc._setConnectionState("connected");
    pc._setConnectionState("disconnected");
    expect(onConnectionClosed).not.toHaveBeenCalled();
  });

  it("assigns a different connectionId to a different peer connection", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc1 = new window.RTCPeerConnection();
    const pc2 = new window.RTCPeerConnection();
    pc1._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    pc2._emit("track", { track: fakeAudioTrack("t2"), streams: [], transceiver: null });
    const [{ connectionId: id1 }] = onRemoteAudioTrack.mock.calls[0];
    const [{ connectionId: id2 }] = onRemoteAudioTrack.mock.calls[1];
    expect(id1).not.toBe(id2);
  });

  it("logs remote-track-observed with full context for every audio track event", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const logs = [];
    installRtcPatch({
      onRemoteAudioTrack: () => {},
      onConnectionClosed: () => {},
      log: (event, details) => logs.push({ event, details }),
    });
    const pc = new window.RTCPeerConnection();
    const track = fakeAudioTrack("t1");
    const stream = { id: "s1" };
    pc._emit("track", { track, streams: [stream], transceiver: { mid: "0" } });

    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe("remote-track-observed");
    expect(logs[0].details).toMatchObject({
      connectionState: "new",
      streamId: "s1",
      mid: "0",
      trackId: "t1",
    });
    expect(typeof logs[0].details.connectionId).toBe("number");
  });

  it("logs connection-state-changed on every connectionstatechange, not only closed/failed", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const logs = [];
    installRtcPatch({
      onRemoteAudioTrack: () => {},
      onConnectionClosed: () => {},
      log: (event, details) => logs.push({ event, details }),
    });
    const pc = new window.RTCPeerConnection();

    pc._setConnectionState("connected");
    pc._setConnectionState("disconnected");
    pc._setConnectionState("closed");

    const stateChangeLogs = logs.filter((entry) => entry.event === "connection-state-changed");
    expect(stateChangeLogs.map((entry) => entry.details.connectionState)).toEqual([
      "connected",
      "disconnected",
      "closed",
    ]);
  });
});

describe("remote audio connection recovery", () => {
  it("preserves the mixer source and sender lookup across failure and recovery without a new track event", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack, diagnostics } = await import("./rtc-patch.js");
    const { MeetingAudioMixer } = await import("./audio-mixer.js");
    vi.stubGlobal("MediaStream", class { constructor(tracks) { this.tracks = tracks; } });
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const mixer = new MeetingAudioMixer({ recordingType: "webrtc", audioContext: {
      createMediaStreamDestination: () => ({ stream: {} }),
      createMediaStreamSource: () => source,
    } });
    installRtcPatch({
      onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
      onConnectionClosed: (id) => mixer.removeConnection(id),
    });
    const pc = new window.RTCPeerConnection();
    const remote = { ...fakeAudioTrack("remote"), readyState: "live", addEventListener() {} };
    const mic = fakeAudioTrack("mic");
    pc._setSenders([{ track: mic }]);
    pc._setConnectionState("connected");
    pc._emit("track", { track: remote, streams: [], transceiver: { mid: "0" } });

    pc._setConnectionState("failed");
    expect(getCurrentLocalAudioTrack()).toBeNull();
    pc._setConnectionState("connecting");
    pc._setConnectionState("connected");
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(source.disconnect).not.toHaveBeenCalled();
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(getCurrentLocalAudioTrack()).toBe(mic);
    expect(diagnostics.connectionsClosed).toBe(0);

    pc._setConnectionState("closed");
    expect(mixer.activeRemoteSourceCount).toBe(0);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(getCurrentLocalAudioTrack()).toBeNull();
    expect(diagnostics.connectionsClosed).toBe(1);
  });

  it("captures an audio track arriving while the connection is failed", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc._setConnectionState("failed");
    const track = fakeAudioTrack("remote");
    pc._emit("track", { track, streams: [], transceiver: { mid: "0" } });
    pc._setConnectionState("connected");

    expect(onRemoteAudioTrack).toHaveBeenCalledTimes(1);
    expect(onRemoteAudioTrack).toHaveBeenCalledWith({
      track, stream: null, mid: "0", connectionId: expect.any(Number),
    });
  });
});

describe("installGetUserMediaPatch", () => {
  it("calls onMicStream with the stream and audio track when audio is requested", async () => {
    vi.resetModules();
    const { installGetUserMediaPatch } = await import("./rtc-patch.js");
    const audioTrack = fakeAudioTrack("mic-1");
    const stream = { getAudioTracks: () => [audioTrack] };
    const originalGetUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });

    const onMicStream = vi.fn();
    installGetUserMediaPatch({ onMicStream });

    const result = await navigator.mediaDevices.getUserMedia({ audio: true });

    expect(result).toBe(stream);
    expect(onMicStream).toHaveBeenCalledWith(stream, audioTrack);
  });

  it("does not call onMicStream when the constraints have no audio", async () => {
    vi.resetModules();
    const { installGetUserMediaPatch } = await import("./rtc-patch.js");
    const stream = { getAudioTracks: () => [] };
    const originalGetUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });

    const onMicStream = vi.fn();
    installGetUserMediaPatch({ onMicStream });

    await navigator.mediaDevices.getUserMedia({ video: true });

    expect(onMicStream).not.toHaveBeenCalled();
  });
});

describe("getCurrentLocalAudioTrack", () => {
  it("returns null when there are no active connections", async () => {
    vi.resetModules();
    const { getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    expect(getCurrentLocalAudioTrack()).toBeNull();
  });

  it("returns the current audio sender's track from an active connection", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    const audioTrack = fakeAudioTrack("mic-1");
    pc._setSenders([{ track: { kind: "video", id: "v1" } }, { track: audioTrack }]);

    expect(getCurrentLocalAudioTrack()).toBe(audioTrack);
  });

  it("prefers a candidate from a connection whose connectionState is 'connected' over one that is merely not closed", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const staleConnectionTrack = fakeAudioTrack("stale");
    const activeConnectionTrack = fakeAudioTrack("active");
    const stalePc = new window.RTCPeerConnection();
    stalePc._setSenders([{ track: staleConnectionTrack }]);
    stalePc._setConnectionState("disconnected");
    const activePc = new window.RTCPeerConnection();
    activePc._setSenders([{ track: activeConnectionTrack }]);
    activePc._setConnectionState("connected");

    expect(getCurrentLocalAudioTrack()).toBe(activeConnectionTrack);
  });

  it("skips a connection whose connectionState is closed/failed even if it's still in the active set", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc._setSenders([{ track: fakeAudioTrack("mic-1") }]);
    // Mutated directly (not via _setConnectionState, which would also fire our
    // own "connectionstatechange" listener and remove this pc from
    // activeConnections) - this exercises getCurrentLocalAudioTrack's own
    // internal closed/failed guard specifically, independent of that cleanup,
    // per Codex's review: the original version of this test only exercised the
    // Set-removal side effect, never the guard itself.
    pc.connectionState = "closed";

    expect(getCurrentLocalAudioTrack()).toBeNull();
  });

  it("logs every candidate it considered (not just the one it picked)", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const disconnectedTrack = fakeAudioTrack("disconnected-mic");
    const connectedTrack = fakeAudioTrack("connected-mic");
    const disconnectedPc = new window.RTCPeerConnection();
    disconnectedPc._setSenders([{ track: disconnectedTrack }]);
    disconnectedPc._setConnectionState("disconnected");
    const connectedPc = new window.RTCPeerConnection();
    connectedPc._setSenders([{ track: connectedTrack }]);
    connectedPc._setConnectionState("connected");
    const logs = [];

    getCurrentLocalAudioTrack({ log: (event, details) => logs.push({ event, details }) });

    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe("current-local-audio-track-lookup");
    expect(logs[0].details.candidateCount).toBe(2);
    expect(logs[0].details.candidates.map((c) => c.trackId).sort()).toEqual(["connected-mic", "disconnected-mic"]);
    expect(logs[0].details.selectedTrackId).toBe("connected-mic");
  });
});

describe("installReplaceTrackPatch", () => {
  let originalRTCRtpSender;

  beforeEach(() => {
    originalRTCRtpSender = window.RTCRtpSender;
    window.RTCRtpSender = class {
      constructor(track) {
        this.track = track;
      }
      async replaceTrack(newTrack) {
        this.track = newTrack;
        // Valor centinela devuelto a propósito, para poder comprobar que
        // installReplaceTrackPatch preserva lo que el replaceTrack original
        // resolvió (el contrato real de RTCRtpSender.replaceTrack()), en vez
        // de perderlo o devolver undefined siempre.
        return "replace-track-resolved-value";
      }
    };
  });

  afterEach(() => {
    window.RTCRtpSender = originalRTCRtpSender;
  });

  it("calls onAudioTrackReplaced (after the replacement resolves) and logs the attempt", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    const onAudioTrackReplaced = vi.fn();
    const logs = [];
    installReplaceTrackPatch({ onAudioTrackReplaced, log: (event, details) => logs.push({ event, details }) });

    const oldTrack = fakeAudioTrack("old");
    const newTrack = fakeAudioTrack("new");
    const sender = new window.RTCRtpSender(oldTrack);

    const resolvedValue = await sender.replaceTrack(newTrack);

    expect(resolvedValue).toBe("replace-track-resolved-value");
    expect(onAudioTrackReplaced).toHaveBeenCalledWith(newTrack, oldTrack);
    expect(logs).toContainEqual({
      event: "sender-replace-track",
      details: { kind: "audio", previousTrackId: "old", newTrackId: "new" },
    });
  });

  it("does not call onAudioTrackReplaced for a video sender's track replacement", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    const onAudioTrackReplaced = vi.fn();
    installReplaceTrackPatch({ onAudioTrackReplaced });

    const oldTrack = { kind: "video", id: "old-v" };
    const newTrack = { kind: "video", id: "new-v" };
    const sender = new window.RTCRtpSender(oldTrack);
    await sender.replaceTrack(newTrack);

    expect(onAudioTrackReplaced).not.toHaveBeenCalled();
  });

  it("still calls through to the original replaceTrack behavior", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    installReplaceTrackPatch({ onAudioTrackReplaced: () => {} });

    const oldTrack = fakeAudioTrack("old");
    const newTrack = fakeAudioTrack("new");
    const sender = new window.RTCRtpSender(oldTrack);
    await sender.replaceTrack(newTrack);

    expect(sender.track).toBe(newTrack);
  });

  it("does not call onAudioTrackReplaced if the underlying replaceTrack call rejects", async () => {
    // Real gap Codex's review caught in the first version of this plan: firing
    // onAudioTrackReplaced before awaiting the original call would switch the
    // mixer to a track that Meet's own replaceTrack call never actually
    // accepted.
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    window.RTCRtpSender = class {
      constructor(track) {
        this.track = track;
      }
      async replaceTrack() {
        throw new Error("replaceTrack failed");
      }
    };
    const onAudioTrackReplaced = vi.fn();
    installReplaceTrackPatch({ onAudioTrackReplaced });

    const sender = new window.RTCRtpSender(fakeAudioTrack("old"));
    await expect(sender.replaceTrack(fakeAudioTrack("new"))).rejects.toThrow("replaceTrack failed");
    expect(onAudioTrackReplaced).not.toHaveBeenCalled();
  });

  it("increments diagnostics.audioSenderReplacements only for successful audio sender replacements", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch, diagnostics } = await import("./rtc-patch.js");
    installReplaceTrackPatch({ onAudioTrackReplaced: () => {} });

    const sender = new window.RTCRtpSender(fakeAudioTrack("old"));
    await sender.replaceTrack(fakeAudioTrack("new"));
    await sender.replaceTrack(fakeAudioTrack("newer"));

    expect(diagnostics.audioSenderReplacements).toBe(2);
  });

  it("does not double-wrap replaceTrack when installed more than once", async () => {
    // Guards against Meet triggering two log lines / two callback firings for
    // one real replaceTrack call if installReplaceTrackPatch were ever
    // (accidentally) called twice.
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    installReplaceTrackPatch({ onAudioTrackReplaced: firstCallback });
    installReplaceTrackPatch({ onAudioTrackReplaced: secondCallback });

    const sender = new window.RTCRtpSender(fakeAudioTrack("old"));
    await sender.replaceTrack(fakeAudioTrack("new"));

    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).not.toHaveBeenCalled();
  });
});


describe("sweepRemoteAudioTracks", () => {
  it("discovers live audio without track events and excludes other tracks", async () => {
    vi.resetModules();
    const { installRtcPatch, sweepRemoteAudioTracks } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn() });
    const pc = new window.RTCPeerConnection();
    const receiver = { track: { kind: "audio", id: "remote", readyState: "live" } };
    pc._receivers = [receiver, { track: { kind: "video", readyState: "live" } }, { track: { kind: "audio", readyState: "ended" } }, { track: null }];
    pc._transceivers = [{ receiver, mid: "1" }];
    const onRemoteAudioTrack = vi.fn(() => "added");
    const result = sweepRemoteAudioTracks({ onRemoteAudioTrack });
    expect(result).toMatchObject({ tracksFound: 1, recovered: 1, errors: [] });
    expect(onRemoteAudioTrack).toHaveBeenCalledWith(expect.objectContaining({ track: receiver.track, mid: "1", stream: null }));
  });

  it("preserves receiver stream metadata across replacement without another track event", async () => {
    vi.resetModules();
    const { installRtcPatch, sweepRemoteAudioTracks } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn() });
    const pc = new window.RTCPeerConnection();
    const receiver = { track: { kind: "audio", id: "old", readyState: "live" } };
    const stream = { id: "stream" };
    pc._receivers = [receiver];
    pc._emit("track", { track: receiver.track, receiver, streams: [stream], transceiver: { mid: "2" } });
    receiver.track = { kind: "audio", id: "new", readyState: "live" };
    const onRemoteAudioTrack = vi.fn();
    sweepRemoteAudioTracks({ onRemoteAudioTrack });
    expect(onRemoteAudioTrack).toHaveBeenCalledWith(expect.objectContaining({ track: receiver.track, stream, mid: "2" }));
  });

  it("isolates lookup and incorporation errors and retries after failure and ICE recovery", async () => {
    vi.resetModules();
    const { installRtcPatch, sweepRemoteAudioTracks } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn() });
    const bad = new window.RTCPeerConnection();
    bad.getReceivers = () => { throw new Error("lookup"); };
    const good = new window.RTCPeerConnection();
    good._receivers = [{ track: { kind: "audio", id: "live", readyState: "live" } }];
    const onRemoteAudioTrack = vi.fn().mockImplementationOnce(() => { throw new Error("connect"); }).mockReturnValue("added");
    expect(sweepRemoteAudioTracks({ onRemoteAudioTrack }).errors).toHaveLength(2);
    expect(sweepRemoteAudioTracks({ onRemoteAudioTrack }).recovered).toBe(1);
    good._setConnectionState("failed");
    expect(sweepRemoteAudioTracks({ onRemoteAudioTrack }).tracksFound).toBe(0);
    good._setConnectionState("connected");
    expect(sweepRemoteAudioTracks({ onRemoteAudioTrack }).tracksFound).toBe(1);
    good._setConnectionState("closed");
    expect(sweepRemoteAudioTracks({ onRemoteAudioTrack }).tracksFound).toBe(0);
  });

  it("can still discover tracks if transceiver lookup fails", async () => {
    vi.resetModules();
    const { installRtcPatch, sweepRemoteAudioTracks } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn() });
    const pc = new window.RTCPeerConnection();
    pc._receivers = [{ track: { kind: "audio", id: "remote", readyState: "live" } }];
    pc.getTransceivers = () => { throw new Error("mid unavailable"); };
    const onRemoteAudioTrack = vi.fn();
    const result = sweepRemoteAudioTracks({ onRemoteAudioTrack });
    expect(result.errors).toHaveLength(1);
    expect(onRemoteAudioTrack).toHaveBeenCalledOnce();
  });
});


it("sweeps only transceivers negotiated to receive audio", async () => {
  vi.resetModules();
  const { installRtcPatch, sweepRemoteAudioTracks } = await import("./rtc-patch.js");
  installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn() });
  const pc = new window.RTCPeerConnection();
  pc._transceivers = ["sendonly", "inactive", "recvonly", "sendrecv"].map((currentDirection) => ({
    currentDirection, mid: currentDirection,
    receiver: { track: { kind: "audio", readyState: "live", id: currentDirection } },
  }));
  pc._receivers = pc._transceivers.map(({ receiver }) => receiver);
  const result = sweepRemoteAudioTracks({ onRemoteAudioTrack: vi.fn() });
  expect(result.tracks.map(({ trackId }) => trackId)).toEqual(["recvonly", "sendrecv"]);
});

it("inspects audio RTP metadata and isolates failures without touching tracks", async () => {
  vi.resetModules();
  const { installRtcPatch, inspectRemoteReceivers } = await import("./rtc-patch.js");
  installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn() });
  const bad = new window.RTCPeerConnection();
  bad.getReceivers = () => { throw new Error("lookup"); };
  const good = new window.RTCPeerConnection();
  const report = { type: "inbound-rtp", kind: "audio", timestamp: 1234, packetsReceived: 50,
    bytesReceived: 4000, audioLevel: 0, totalAudioEnergy: 0, codecId: "codec" };
  const track = { kind: "audio", id: "remote", enabled: true, muted: false, readyState: "live", stop: vi.fn() };
  good._receivers = [
    { track, getStats: async () => new Map([["audio", report], ["codec", { mimeType: "audio/opus" }]]) },
    { track: { kind: "video" }, getStats: vi.fn() },
    { track: { ...track, id: "failed" }, getStats: async () => { throw new Error("stats"); } },
  ];
  const result = await inspectRemoteReceivers();
  expect(result).toHaveLength(3);
  expect(result[0].error).toBe("lookup");
  expect(result[1]).toMatchObject({ trackId: "remote", enabled: true, muted: false,
    inbound: [{ packetsReceived: 50, bytesReceived: 4000, totalAudioEnergy: 0, totalSamplesDuration: null, codec: "audio/opus" }] });
  expect(result[2].error).toBe("stats");
  expect(track.stop).not.toHaveBeenCalled();
});

it("discovers outgoing live tracks, isolates failing connections and preserves native addTrack results", async () => {
  vi.resetModules();
  const { installRtcPatch, sweepLocalAudioTracks } = await import("./rtc-patch.js");
  const original = FakePeerConnection.prototype.addTrack;
  FakePeerConnection.prototype.addTrack = function(track) {
    if (track.id === "rejected") throw new Error("native rejection");
    const sender = { track }; this._senders.push(sender); return sender;
  };
  try {
    const observed = vi.fn(); installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn(), onLocalAudioTrack: observed });
    installRtcPatch({ onRemoteAudioTrack: vi.fn(), onConnectionClosed: vi.fn(), onLocalAudioTrack: observed });
    const pc = new window.RTCPeerConnection(), track = { kind: "audio", id: "local", readyState: "live" };
    expect(pc.addTrack(track).track).toBe(track); expect(observed).toHaveBeenCalledOnce();
    expect(() => pc.addTrack({ ...track, id: "rejected" })).toThrow("native rejection");
    pc._senders.push({ track: { ...track, id: "video", kind: "video" } }, { track: { ...track, id: "ended", readyState: "ended" } });
    const bad = new window.RTCPeerConnection(); bad.getSenders = () => { throw new Error("lookup"); };
    const found = sweepLocalAudioTracks({ onLocalAudioTrack: observed }); expect([...found.keys()]).toEqual(["local"]);
    pc._setConnectionState("failed"); expect(sweepLocalAudioTracks({ onLocalAudioTrack: observed }).size).toBe(0);
    pc._setConnectionState("connected"); expect(sweepLocalAudioTracks({ onLocalAudioTrack: observed }).size).toBe(1);
  } finally { FakePeerConnection.prototype.addTrack = original; }
});
