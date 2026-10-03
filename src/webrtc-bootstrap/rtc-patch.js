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
// Conexiones parcheadas que siguen abiertas - permite, en cualquier momento,
// mirar qué track de audio se está enviando AHORA (ver getCurrentLocalAudioTrack),
// en vez de depender únicamente del track que getUserMedia devolvió una sola
// vez al principio.
const activeConnections = new Set();
const trackMetadata = new WeakMap();
const receiverMetadata = new WeakMap();

function getConnectionId(pc) {
  if (!connectionIds.has(pc)) connectionIds.set(pc, nextConnectionId++);
  return connectionIds.get(pc);
}

export function installRtcPatch({ onRemoteAudioTrack, onConnectionClosed, onLocalAudioTrack = () => {}, onDataChannel = () => {}, onConnectionStateChange = () => {}, log = () => {} }) {
  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection || OriginalRTCPeerConnection.__ariadnePatched) return;

  function PatchedRTCPeerConnection(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    diagnostics.peerConnectionsCreated += 1;
    // Asignado acá mismo (no de forma perezosa en el primer "track"/close) para
    // que cada conexión parcheada tenga su identidad desde el momento en que se
    // crea, no solo desde su primer evento.
    const connectionId = getConnectionId(pc);
    activeConnections.add(pc);
    pc.addEventListener("datachannel", ({ channel }) => {
      try { onDataChannel(channel); } catch (error) { log("data-channel-observer-error", { message: error.message }); }
    });
    const createDataChannel = pc.createDataChannel;
    if (createDataChannel) pc.createDataChannel = function(...args) {
      const channel = createDataChannel.apply(this, args);
      try { onDataChannel(channel); } catch (error) { log("media-state-error", { message: error.message }); }
      return channel;
    };
    const addTrack = pc.addTrack;
    pc.addTrack = function(track, ...streams) {
      const result = addTrack.call(this, track, ...streams);
      if (track.kind === "audio") {
        try { onLocalAudioTrack(track); } catch (error) { log("local-source-error", { message: error.message }); }
      }
      return result;
    };

    pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      const streamId = event.streams?.[0]?.id ?? null;
      const mid = event.transceiver?.mid ?? null;
      // Logueado ANTES del guard de closed a propósito: si alguna vez
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
      if (pc.connectionState === "closed") return;
      diagnostics.remoteAudioTracksSeen += 1;
      const metadata = { stream: event.streams?.[0] ?? null, mid };
      trackMetadata.set(event.track, metadata);
      if (event.receiver) receiverMetadata.set(event.receiver, metadata);
      onRemoteAudioTrack({ track: event.track, receiver: event.receiver, ...metadata, connectionId });
    });

    pc.addEventListener("connectionstatechange", () => {
      try { onConnectionStateChange(pc.connectionState); } catch (error) { log("connection-observer-error", { message: error.message }); }
      log("connection-state-changed", { connectionId, connectionState: pc.connectionState });
      // ICE failure can recover on this same connection. Only a real close
      // permanently removes its tracks and its entry in activeConnections.
      if (pc.connectionState === "closed") {
        diagnostics.connectionsClosed += 1;
        activeConnections.delete(pc);
        onConnectionClosed(connectionId);
      }
    });

    return pc;
  }

  PatchedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(PatchedRTCPeerConnection, OriginalRTCPeerConnection);
  Object.defineProperty(PatchedRTCPeerConnection, "__ariadnePatched", { value: true });
  window.RTCPeerConnection = PatchedRTCPeerConnection;
}

// Receiver lookup complements track events; it does not own or stop Meet tracks.
export function sweepRemoteAudioTracks({ onRemoteAudioTrack, log = () => {} }) {
  const result = { connectionsScanned: 0, tracksFound: 0, recovered: 0, errors: [], tracks: [] };
  for (const pc of activeConnections) {
    if (pc.connectionState === "closed" || pc.connectionState === "failed") continue;
    const connectionId = getConnectionId(pc);
    result.connectionsScanned += 1;
    let receivers;
    let transceivers = [];
    try {
      receivers = pc.getReceivers();
    } catch (error) {
      result.errors.push({ connectionId, operation: "getReceivers", message: String(error.message ?? error) });
      continue;
    }
    try {
      transceivers = pc.getTransceivers?.() ?? [];
    } catch (error) {
      result.errors.push({ connectionId, operation: "getTransceivers", message: String(error.message ?? error) });
    }
    for (const receiver of receivers) {
      const track = receiver.track;
      if (!track || track.kind !== "audio" || track.readyState !== "live") continue;
      const transceiver = transceivers.find((item) => item.receiver === receiver);
      // getReceivers also exposes live tracks on send-only/inactive transceivers.
      if (transceiver?.stopped || (transceiver?.currentDirection != null &&
          !["recvonly", "sendrecv"].includes(transceiver.currentDirection))) continue;
      const known = trackMetadata.get(track) ?? receiverMetadata.get(receiver);
      const payload = {
        discovery: "sweep", receiver, connectionId, track, stream: known?.stream ?? null,
        mid: transceiver?.mid ?? known?.mid ?? null,
      };
      result.tracksFound += 1;
      result.tracks.push({ connectionId, trackId: track.id, connectionState: pc.connectionState });
      try {
        if (["added", "reconnected"].includes(onRemoteAudioTrack(payload))) result.recovered += 1;
      } catch (error) {
        result.errors.push({ connectionId, trackId: track.id, operation: "addRemoteTrack", message: String(error.message ?? error) });
      }
    }
  }
  for (const error of result.errors) log("receiver-sweep-error", error);
  if (result.recovered) log("receiver-sweep-recovered", { recovered: result.recovered });
  return result;
}

// On-demand metadata only: packet counters help distinguish receiving RTP
// from a PCM track that actually delivers samples to Web Audio.
export async function inspectRemoteReceivers() {
  const receivers = [];
  for (const pc of activeConnections) {
    const connectionId = getConnectionId(pc);
    let candidates;
    try { candidates = pc.getReceivers(); }
    catch (error) {
      receivers.push({ connectionId, error: String(error.message ?? error) });
      continue;
    }
    for (const receiver of candidates) {
      if (receiver.track?.kind !== "audio") continue;
      const track = receiver.track;
      const entry = { connectionId, connectionState: pc.connectionState,
        trackId: track.id, readyState: track.readyState, enabled: track.enabled,
        muted: track.muted, inbound: [] };
      try {
        const reports = await receiver.getStats();
        for (const report of reports.values()) {
          if (report.type !== "inbound-rtp" || (report.kind ?? report.mediaType ?? "audio") !== "audio") continue;
          entry.inbound.push({
            timestamp: report.timestamp, packetsReceived: report.packetsReceived ?? null,
            bytesReceived: report.bytesReceived ?? null, audioLevel: report.audioLevel ?? null,
            totalAudioEnergy: report.totalAudioEnergy ?? null,
            totalSamplesDuration: report.totalSamplesDuration ?? null,
            codec: reports.get(report.codecId)?.mimeType ?? null,
          });
        }
      } catch (error) { entry.error = String(error.message ?? error); }
      receivers.push(entry);
    }
  }
  return receivers;
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
// RTCRtpSender.track) - a diferencia de installGetUserMediaPatch, que solo
// ve el track original de la primera vez que Meet pidió el micrófono. Si
// Meet reemplazó ese track más tarde (ver installReplaceTrackPatch), esto
// devuelve el reemplazo; el original capturado por getUserMedia queda
// obsoleto y no se usa acá.
//
// Puede haber más de un candidato (más de una conexión con un sender de
// audio activo). Entre ellos, se prioriza uno cuya conexión esté realmente
// "connected" por sobre uno que simplemente no llegó todavía a "closed"/
// "failed" (p. ej. "new" o "disconnected") - Codex's review señaló que
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
// enviando (RTCRtpSender.replaceTrack) - algo que installGetUserMediaPatch,
// por sí solo, nunca ve, porque esa función solo se entera del track
// original devuelto por getUserMedia() la primera vez. Hipótesis de esta
// investigación (revisada por Codex dos veces como plausible pero NO
// confirmada contra una reunión real): si Meet vuelve a llamar replaceTrack
// con un track ya procesado internamente (con su propio control de
// volumen/normalización), seguir usando el track original sin enterarnos
// del reemplazo explicaría por qué la voz propia grabada suena más baja que
// en una extensión comparable, que sí detecta estos reemplazos (confirmado
// inspeccionando su código).
//
// onAudioTrackReplaced se dispara DESPUÉS de que el replaceTrack original se
// resuelve con éxito, no antes - si Meet intenta un reemplazo que termina
// rechazado, no queremos que el mixer igual cambie de track (bug real que
// Codex encontró en la primera versión de este plan). Se dispara para
// CUALQUIER reemplazo exitoso de un sender de audio, incluido un reemplazo a
// `null` (Meet deja de enviar audio, un uso legítimo de replaceTrack) - esta
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
        try { onAudioTrackReplaced(newTrack, previousTrack); }
        catch (error) { log("local-source-error", { message: error.message }); }
      }
      return result;
    });
  };
}


export function sweepLocalAudioTracks({ onLocalAudioTrack, log = () => {} }) {
  const tracks = new Map();
  for (const pc of activeConnections) {
    if (["closed", "failed"].includes(pc.connectionState)) continue;
    try {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === "audio" && sender.track.readyState === "live") tracks.set(sender.track.id, sender.track);
      }
    } catch (error) { log("sender-sweep-error", { message: error.message }); }
  }
  for (const track of tracks.values()) {
    try { onLocalAudioTrack(track); } catch (error) { log("local-source-error", { trackId: track.id, message: error.message }); }
  }
  return tracks;
}
