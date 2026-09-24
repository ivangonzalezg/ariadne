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
  getSenders() {
    return this._senders;
  }
  _setSenders(senders) {
    this._senders = senders;
  }
  getReceivers() {
    return this._receivers;
  }
  getTransceivers() {
    return this._transceivers;
  }
  _setReceivers(receivers) {
    this._receivers = receivers;
  }
  _setTransceivers(transceivers) {
    this._transceivers = transceivers;
  }
}

function fakeAudioTrack(id) {
  return { kind: "audio", id };
}

let originalRTCPeerConnection;

beforeEach(() => {
  originalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = FakePeerConnection;
});

afterEach(() => {
  window.RTCPeerConnection = originalRTCPeerConnection;
  vi.restoreAllMocks();
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

  it("calls onConnectionClosed when the connection fails", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onConnectionClosed = vi.fn();
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed });
    const pc = new window.RTCPeerConnection();
    pc._setConnectionState("failed");
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

describe("reconcileRemoteReceivers", () => {
  it("discovers live audio receiver tracks and finds their mid through the matching transceiver", async () => {
    vi.resetModules();
    const { installRtcPatch, reconcileRemoteReceivers } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    const audioTrack = { kind: "audio", id: "receiver-audio", readyState: "live" };
    const receiver = { track: audioTrack };
    pc._setReceivers([receiver, { track: { kind: "video", id: "video", readyState: "live" } }]);
    pc._setTransceivers([{ receiver, mid: "7" }]);

    reconcileRemoteReceivers();

    expect(onRemoteAudioTrack).toHaveBeenCalledWith({
      track: audioTrack,
      stream: null,
      mid: "7",
      connectionId: expect.any(Number),
    });
  });

  it("runs an immediate receiver sweep when a connection becomes connected", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    const track = { kind: "audio", id: "receiver-audio", readyState: "live" };
    const receiver = { track };
    pc._setReceivers([receiver]);
    pc._setTransceivers([{ receiver, mid: "0" }]);

    pc._setConnectionState("connected");

    expect(onRemoteAudioTrack).toHaveBeenCalledWith(expect.objectContaining({ track, mid: "0" }));
  });

  it("continues the sweep when getReceivers or getTransceivers throws", async () => {
    vi.resetModules();
    const { installRtcPatch, reconcileRemoteReceivers } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const brokenReceivers = new window.RTCPeerConnection();
    brokenReceivers.getReceivers = () => { throw new Error("receivers unavailable"); };
    const brokenTransceivers = new window.RTCPeerConnection();
    const noMidTrack = { kind: "audio", id: "no-mid", readyState: "live" };
    brokenTransceivers._setReceivers([{ track: noMidTrack }]);
    brokenTransceivers.getTransceivers = () => { throw new Error("transceivers unavailable"); };
    const working = new window.RTCPeerConnection();
    const track = { kind: "audio", id: "working", readyState: "live" };
    const receiver = { track };
    working._setReceivers([{ track: receiver.track }]);
    working._setTransceivers([{ receiver: working.getReceivers()[0], mid: "3" }]);

    expect(() => reconcileRemoteReceivers()).not.toThrow();
    expect(onRemoteAudioTrack).toHaveBeenCalledWith(expect.objectContaining({ track: noMidTrack, mid: null }));
    expect(onRemoteAudioTrack).toHaveBeenCalledWith(expect.objectContaining({ track, mid: "3" }));
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
