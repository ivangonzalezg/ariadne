// src/webrtc-bootstrap/audio-mixer.js
const MUTE_STALE_THRESHOLD_MS = 15000;

export class MeetingAudioMixer {
  constructor({ audioContext = new AudioContext(), now = () => Date.now(), log = () => {} } = {}) {
    this.audioContext = audioContext;
    this.now = now;
    this.log = log;
    this.destination = this.audioContext.createMediaStreamDestination();
    this._forceStereoChannelConfig(this.destination, "destination");
    // key -> { key, connectionId, sourceNode, track, staleSince }
    this.remoteSources = new Map();
    // MediaStreamTrack -> key, para deduplicar receivers/eventos track en O(1).
    this.remoteKeyByTrack = new WeakMap();
    // connectionId -> Set<key>, for O(1) purge-by-connection
    this.connectionKeys = new Map();
    this.micSourceNode = null;
    this.micGainNode = null;
  }

  // Fuerza explícitamente 2 canales (estéreo) en el nodo, en vez de confiar
  // en su configuración por defecto. NOTA (agregada tras la revisión de
  // Codex): por spec, MediaStreamAudioDestinationNode YA viene por defecto
  // con channelCount=2/channelCountMode="explicit"/channelInterpretation=
  // "speakers" - así que forzar esto en `destination` es casi seguro un
  // no-op, no una reparación confirmada. Lo mantenemos igual porque no
  // cuesta nada y Codex lo recomendó como hardening defensivo, pero NO debe
  // presentarse como "la solución" sin evidencia de un caso real donde el
  // valor por defecto haya sido distinto. Por eso este método loguea el
  // valor ANTES de pisarlo - es la evidencia real que nos falta hoy.
  _forceStereoChannelConfig(node, label) {
    this.log("mixer-channel-config-before", {
      node: label,
      channelCount: node.channelCount,
      channelCountMode: node.channelCountMode,
      channelInterpretation: node.channelInterpretation,
    });
    node.channelCount = 2;
    node.channelCountMode = "explicit";
    node.channelInterpretation = "speakers";
    this.log("mixer-channel-config-after", { node: label, channelCount: node.channelCount });
  }

  get activeRemoteSourceCount() {
    return this.remoteSources.size;
  }

  // Global por stream.id cuando hay un MediaStream disponible - así, SI Meet
  // reutiliza el mismo MediaStream.id para el mismo participante al reconectar o
  // renegociar (con una RTCPeerConnection nueva, y por lo tanto un connectionId
  // distinto), lo tratamos como la MISMA fuente y la reemplazamos (ver
  // addRemoteTrack) en vez de sumar una copia adicional. Esta es la hipótesis
  // objetivo para el eco que el usuario detectó comparando contra una extensión
  // comparable (cuyo código usa este mismo esquema global) - confirmada como plausible por
  // dos revisiones de Codex, pero todavía no confirmada contra una reunión real;
  // ver el logging de diagnóstico en rtc-patch.js y la verificación manual del
  // plan que introdujo este cambio para cómo se termina de confirmar o
  // descartar. `mid` NO es seguro tratarlo así: son enteros chicos ("0", "1",
  // ...) que se reinician por conexión, así que dos conexiones distintas casi
  // seguro van a tener el mismo mid para participantes DISTINTOS - por eso ese
  // fallback (y el de track.id) se mantienen scopeados a la conexión.
  _remoteKey(connectionId, { streamId, mid, track }) {
    if (streamId) return `stream:${streamId}`;
    if (mid) return `conn:${connectionId}:mid:${mid}`;
    return `conn:${connectionId}:track:${track.id}`;
  }

  addRemoteTrack({ track, stream, mid, connectionId }) {
    const existingKeyForTrack = this.remoteKeyByTrack.get(track);
    const key = this._remoteKey(connectionId, { streamId: stream?.id ?? null, mid, track });
    const existingForTrack = existingKeyForTrack ? this.remoteSources.get(existingKeyForTrack) : null;
    if (existingForTrack) {
      if (key.startsWith("stream:") && !existingForTrack.key.startsWith("stream:")) {
        this._migrateEntry(existingForTrack, key, stream);
      }
      return;
    }

    const existing = this.remoteSources.get(key);
    if (existing) this._teardownEntry(key, existing, "replaced by a newer track for the same slot");

    // Siempre envolvemos solo este track en su propio MediaStream - nunca usamos
    // `stream` (el MediaStream completo del evento) directamente acá, porque si
    // ese stream tuviera más de un track, createMediaStreamSource podría tomar
    // uno distinto al que realmente nos interesa. `stream` se usa únicamente
    // como identidad (su .id) y para el listener de "removetrack" más abajo.
    const sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([track]));
    sourceNode.connect(this.destination);

    const entry = { key, connectionId, sourceNode, track, staleSince: null, stream: null };
    this.remoteSources.set(key, entry);
    this.remoteKeyByTrack.set(track, key);

    let keysForConnection = this.connectionKeys.get(connectionId);
    if (!keysForConnection) {
      keysForConnection = new Set();
      this.connectionKeys.set(connectionId, keysForConnection);
    }
    keysForConnection.add(key);

    // Cada listener valida que la entrada actual siga siendo ESTA entrada antes
    // de actuar. Sin esa validación, si este track es reemplazado (ver
    // el `_teardownEntry` de arriba) pero el track viejo sigue vivo un rato y
    // dispara "ended"/"mute"/"unmute" más tarde, esos listeners viejos
    // encontrarían una entrada nueva y la purgarían/marcarían por error. Usar
    // `entry.key` también mantiene los listeners correctos después de migrar.
    track.addEventListener("ended", () => {
      if (this.remoteSources.get(entry.key) === entry) this._removeRemoteSource(entry.key, "track ended");
    });
    track.addEventListener("mute", () => {
      if (this.remoteSources.get(entry.key) === entry) this._markStale(entry.key);
    });
    track.addEventListener("unmute", () => {
      if (this.remoteSources.get(entry.key) === entry) this._clearStale(entry.key);
    });
    this._attachStreamRemovalListener(entry, stream);

    this.log("remote-track-added", { key, connectionId, streamId: stream?.id ?? null, mid, trackId: track.id });
  }

  _migrateEntry(entry, destinationKey, stream) {
    const sourceKey = entry.key;
    const destinationEntry = this.remoteSources.get(destinationKey);
    if (destinationEntry && destinationEntry !== entry) {
      this._teardownEntry(destinationKey, destinationEntry, "replaced by a migrated track for the same slot");
    }
    this.remoteSources.delete(sourceKey);
    const keysForConnection = this.connectionKeys.get(entry.connectionId);
    keysForConnection?.delete(sourceKey);
    keysForConnection?.add(destinationKey);
    entry.key = destinationKey;
    this.remoteSources.set(destinationKey, entry);
    this.remoteKeyByTrack.set(entry.track, destinationKey);
    this._attachStreamRemovalListener(entry, stream);
    this.log("remote-track-migrated", { fromKey: sourceKey, key: destinationKey, connectionId: entry.connectionId, trackId: entry.track.id });
  }

  _attachStreamRemovalListener(entry, stream) {
    if (!stream || entry.stream === stream) return;
    entry.stream = stream;
    stream.addEventListener("removetrack", (event) => {
      if (event.track === entry.track && this.remoteSources.get(entry.key) === entry) {
        this._removeRemoteSource(entry.key, "removed from its MediaStream");
      }
    });
  }

  removeConnection(connectionId) {
    const keys = this.connectionKeys.get(connectionId);
    if (!keys) return;
    for (const key of [...keys]) this._removeRemoteSource(key, "connection closed");
    this.connectionKeys.delete(connectionId);
  }

  reconcile() {
    const now = this.now();
    for (const [key, entry] of [...this.remoteSources]) {
      if (entry.track.readyState !== "live") {
        this._removeRemoteSource(key, "reconcile: track not live");
        continue;
      }
      if (entry.staleSince !== null && now - entry.staleSince > MUTE_STALE_THRESHOLD_MS) {
        this._removeRemoteSource(key, "reconcile: muted too long");
      }
    }
  }

  _markStale(key) {
    const entry = this.remoteSources.get(key);
    if (!entry) return;
    entry.staleSince = this.now();
    this.log("remote-track-muted", { key });
  }

  _clearStale(key) {
    const entry = this.remoteSources.get(key);
    if (!entry) return;
    entry.staleSince = null;
    this.log("remote-track-unmuted", { key });
  }

  _removeRemoteSource(key, reason) {
    const entry = this.remoteSources.get(key);
    if (!entry) return;
    this._teardownEntry(key, entry, reason);
  }

  _teardownEntry(key, entry, reason) {
    try {
      entry.sourceNode.disconnect();
    } catch {
      // ya pudo haber sido desconectado
    }
    this.remoteSources.delete(key);
    if (this.remoteKeyByTrack.get(entry.track) === key) this.remoteKeyByTrack.delete(entry.track);
    const keysForConnection = this.connectionKeys.get(entry.connectionId);
    if (keysForConnection) {
      keysForConnection.delete(key);
      // El mixer vive toda la pestaña y nunca se cierra entre sesiones - si no
      // borramos los Sets vacíos acá, connectionKeys crece sin límite a lo
      // largo de una reunión larga con muchas reconexiones.
      if (keysForConnection.size === 0) this.connectionKeys.delete(entry.connectionId);
    }
    this.log("remote-track-removed", { key, reason });
  }

  setMicTrack(micTrack, { initiallyMuted }) {
    this.log("mic-track-settings", {
      trackId: micTrack.id,
      channelCount: micTrack.getSettings?.()?.channelCount ?? null,
    });

    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch {
        // ya pudo haber sido desconectado
      }
    }
    if (this.micGainNode) {
      try {
        this.micGainNode.disconnect();
      } catch {
        // ya pudo haber sido desconectado
      }
    }

    const micStream = new MediaStream([micTrack]);
    this.micSourceNode = this.audioContext.createMediaStreamSource(micStream);
    this.micGainNode = this.audioContext.createGain();
    this._forceStereoChannelConfig(this.micGainNode, "micGainNode");
    this.micGainNode.gain.value = initiallyMuted ? 0 : 1;
    this.micSourceNode.connect(this.micGainNode);
    this.micGainNode.connect(this.destination);
  }

  setMicMuted(muted) {
    if (!this.micGainNode) return;
    const now = this.audioContext.currentTime;
    const targetGain = muted ? 0 : 1;
    // Rampa corta en vez de asignar gain.value directo - evita un "click" audible
    // en la transición.
    this.micGainNode.gain.cancelScheduledValues(now);
    this.micGainNode.gain.setValueAtTime(this.micGainNode.gain.value, now);
    this.micGainNode.gain.linearRampToValueAtTime(targetGain, now + 0.01);
  }

  get stream() {
    return this.destination.stream;
  }

  async resume() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  async close() {
    await this.audioContext.close();
  }
}
