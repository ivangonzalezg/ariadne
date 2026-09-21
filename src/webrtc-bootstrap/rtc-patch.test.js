import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakePeerConnection {
  constructor() {
    this.connectionState = "new";
    this._listeners = {};
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

  it("ignores a track event when the connection is already closed", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc.connectionState = "closed";
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    expect(onRemoteAudioTrack).not.toHaveBeenCalled();
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
