// src/webrtc-bootstrap/rtc-patch.js
export const diagnostics = {
  installedAt: Date.now(),
  peerConnectionsCreated: 0,
  remoteAudioTracksSeen: 0,
  micTracksSeen: 0,
  connectionsClosed: 0,
  audioSenderReplacements: 0,
};

let nextConnectionId = 1;
const connectionIds = new WeakMap();
// Conexiones parcheadas que siguen abiertas — permite, en cualquier momento,
// mirar qué track de audio se está enviando AHORA (ver getCurrentLocalAudioTrack),
// en vez de depender únicamente del track que getUserMedia devolvió una sola
// vez al principio.
const activeConnections = new Set();

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
    activeConnections.add(pc);

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
        activeConnections.delete(pc);
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

// Busca, entre las conexiones parcheadas que siguen abiertas, el track de
// audio que ACTUALMENTE se está enviando (el que devuelve cada
// RTCRtpSender.track) — a diferencia de installGetUserMediaPatch, que solo
// ve el track original de la primera vez que Meet pidió el micrófono. Si
// Meet reemplazó ese track más tarde (ver installReplaceTrackPatch), esto
// devuelve el reemplazo; el original capturado por getUserMedia queda
// obsoleto y no se usa acá.
//
// Puede haber más de un candidato (más de una conexión con un sender de
// audio activo). Entre ellos, se prioriza uno cuya conexión esté realmente
// "connected" por sobre uno que simplemente no llegó todavía a "closed"/
// "failed" (p. ej. "new" o "disconnected") — Codex's review señaló que
// tomar el primer candidato sin este criterio podía elegir una conexión
// obsoleta en vez de la realmente activa. Se loguean todos los candidatos
// considerados (no solo el elegido) para poder diagnosticar esto si hace
// falta.
export function getCurrentLocalAudioTrack({ log = () => {} } = {}) {
  const candidates = [];
  for (const pc of activeConnections) {
    if (pc.connectionState === "closed" || pc.connectionState === "failed") continue;
    let senders;
    try {
      senders = pc.getSenders();
    } catch {
      continue;
    }
    for (const sender of senders) {
      if (sender.track && sender.track.kind === "audio") {
        candidates.push({
          track: sender.track,
          connectionId: getConnectionId(pc),
          connectionState: pc.connectionState,
        });
      }
    }
  }

  if (candidates.length === 0) {
    log("current-local-audio-track-lookup", { candidateCount: 0, selectedTrackId: null });
    return null;
  }

  const connected = candidates.find((candidate) => candidate.connectionState === "connected");
  const selected = connected ?? candidates[0];
  log("current-local-audio-track-lookup", {
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      trackId: candidate.track.id,
      connectionId: candidate.connectionId,
      connectionState: candidate.connectionState,
    })),
    selectedTrackId: selected.track.id,
  });
  return selected.track;
}

let replaceTrackPatchInstalled = false;

// Detecta cuándo Meet reemplaza el track de audio que efectivamente se está
// enviando (RTCRtpSender.replaceTrack) — algo que installGetUserMediaPatch,
// por sí solo, nunca ve, porque esa función solo se entera del track
// original devuelto por getUserMedia() la primera vez. Hipótesis de esta
// investigación (revisada por Codex dos veces como plausible pero NO
// confirmada contra una reunión real): si Meet vuelve a llamar replaceTrack
// con un track ya procesado internamente (con su propio control de
// volumen/normalización), seguir usando el track original sin enterarnos
// del reemplazo explicaría por qué la voz propia grabada suena más baja que
// en Fireflies, que sí detecta estos reemplazos (confirmado inspeccionando
// su código).
//
// onAudioTrackReplaced se dispara DESPUÉS de que el replaceTrack original se
// resuelve con éxito, no antes — si Meet intenta un reemplazo que termina
// rechazado, no queremos que el mixer igual cambie de track (bug real que
// Codex encontró en la primera versión de este plan). Se dispara para
// CUALQUIER reemplazo exitoso de un sender de audio, incluido un reemplazo a
// `null` (Meet deja de enviar audio, un uso legítimo de replaceTrack) — esta
// función no filtra ese caso; es quien la llama el que decide qué hacer con
// un `newTrack` nulo (ver bootstrap.js, que documenta explícitamente esa
// decisión en vez de ignorarla en silencio).
//
// Idempotente: una segunda llamada a installReplaceTrackPatch() no vuelve a
// envolver replaceTrack (evita duplicar logs/callbacks si por error se
// llamara dos veces).
export function installReplaceTrackPatch({ onAudioTrackReplaced, log = () => {} }) {
  if (replaceTrackPatchInstalled) return;
  if (!window.RTCRtpSender || !window.RTCRtpSender.prototype.replaceTrack) return;
  replaceTrackPatchInstalled = true;
  const originalReplaceTrack = window.RTCRtpSender.prototype.replaceTrack;

  window.RTCRtpSender.prototype.replaceTrack = function (newTrack) {
    const previousTrack = this.track;
    const kind = previousTrack?.kind ?? newTrack?.kind ?? null;
    log("sender-replace-track", {
      kind,
      previousTrackId: previousTrack?.id ?? null,
      newTrackId: newTrack?.id ?? null,
    });
    return originalReplaceTrack.call(this, newTrack).then((result) => {
      if (kind === "audio") {
        diagnostics.audioSenderReplacements += 1;
        onAudioTrackReplaced(newTrack, previousTrack);
      }
      return result;
    });
  };
}
