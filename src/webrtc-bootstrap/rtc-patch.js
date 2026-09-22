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

export function installRtcPatch({ onRemoteAudioTrack, onConnectionClosed, log = () => {} }) {
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
      const streamId = event.streams?.[0]?.id ?? null;
      const mid = event.transceiver?.mid ?? null;
      // Logueado ANTES del guard de closed/failed a propósito: si alguna vez
      // llega un "track" tarde para una conexión ya cerrada, queremos verlo acá
      // (con connectionState reflejando ese estado) aunque onRemoteAudioTrack no
      // se termine llamando.
      log("remote-track-observed", {
        connectionId,
        connectionState: pc.connectionState,
        streamId,
        mid,
        trackId: event.track.id,
      });
      if (pc.connectionState === "closed" || pc.connectionState === "failed") return;
      diagnostics.remoteAudioTracksSeen += 1;
      onRemoteAudioTrack({
        track: event.track,
        stream: event.streams?.[0] ?? null,
        mid,
        connectionId,
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      log("connection-state-changed", { connectionId, connectionState: pc.connectionState });
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
