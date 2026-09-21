// src/webrtc-bootstrap/rtc-patch.js
export const diagnostics = {
  installedAt: Date.now(),
  peerConnectionsCreated: 0,
  remoteAudioTracksSeen: 0,
  micTracksSeen: 0,
  connectionsClosed: 0,
};

let nextConnectionId = 1;
const connectionIds = new WeakMap();

function getConnectionId(pc) {
  if (!connectionIds.has(pc)) connectionIds.set(pc, nextConnectionId++);
  return connectionIds.get(pc);
}

export function installRtcPatch({ onRemoteAudioTrack, onConnectionClosed }) {
  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) return;

  function PatchedRTCPeerConnection(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    diagnostics.peerConnectionsCreated += 1;
    // Asignado acá mismo (no de forma perezosa en el primer "track"/close) para
    // que cada conexión parcheada tenga su identidad desde el momento en que se
    // crea, no solo desde su primer evento.
    const connectionId = getConnectionId(pc);

    pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      if (pc.connectionState === "closed" || pc.connectionState === "failed") return;
      diagnostics.remoteAudioTracksSeen += 1;
      onRemoteAudioTrack({
        track: event.track,
        stream: event.streams?.[0] ?? null,
        mid: event.transceiver?.mid ?? null,
        connectionId,
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        diagnostics.connectionsClosed += 1;
        onConnectionClosed(connectionId);
      }
    });

    return pc;
  }

  PatchedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(PatchedRTCPeerConnection, OriginalRTCPeerConnection);
  window.RTCPeerConnection = PatchedRTCPeerConnection;
}

export function installGetUserMediaPatch({ onMicStream }) {
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await originalGetUserMedia(constraints);
    if (constraints && constraints.audio) {
      const [audioTrack] = stream.getAudioTracks();
      if (audioTrack) {
        diagnostics.micTracksSeen += 1;
        onMicStream(stream, audioTrack);
      }
    }
    return stream;
  };
}
