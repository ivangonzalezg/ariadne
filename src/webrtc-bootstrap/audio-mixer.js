// src/webrtc-bootstrap/audio-mixer.js
const MUTE_STALE_THRESHOLD_MS = 15000;
const RECONCILE_INTERVAL_MS = 5000;

export class MeetingAudioMixer {
  constructor({ audioContext = new AudioContext(), now = () => Date.now(), log = () => {} } = {}) {
    this.audioContext = audioContext;
    this.now = now;
    this.log = log;
    this.destination = this.audioContext.createMediaStreamDestination();
    this._forceStereoChannelConfig(this.destination, "destination");
    // key -> { connectionId, sourceNode, track, staleSince }
    this.remoteSources = new Map();
    // connectionId -> Set<key>, for O(1) purge-by-connection
    this.connectionKeys = new Map();
    this.micSourceNode = null;
    this.micGainNode = null;
    this.reconcileTimer = null;
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
    const key = this._remoteKey(connectionId, { streamId: stream?.id ?? null, mid, track });
    const existing = this.remoteSources.get(key);
    if (existing && existing.track === track) return;
    if (existing) this._teardownEntry(key, existing, "replaced by a newer track for the same slot");

    // Siempre envolvemos solo este track en su propio MediaStream - nunca usamos
    // `stream` (el MediaStream completo del evento) directamente acá, porque si
    // ese stream tuviera más de un track, createMediaStreamSource podría tomar
    // uno distinto al que realmente nos interesa. `stream` se usa únicamente
    // como identidad (su .id) y para el listener de "removetrack" más abajo.
    const sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([track]));
    sourceNode.connect(this.destination);

    const entry = { connectionId, sourceNode, track, staleSince: null };
    this.remoteSources.set(key, entry);

    let keysForConnection = this.connectionKeys.get(connectionId);
    if (!keysForConnection) {
      keysForConnection = new Set();
      this.connectionKeys.set(connectionId, keysForConnection);
    }
    keysForConnection.add(key);

    // Cada listener valida que la entrada en `key` siga siendo ESTE `track`
    // antes de actuar. Sin esa validación, si este track es reemplazado (ver
    // el `_teardownEntry` de arriba) pero el track viejo sigue vivo un rato y
    // dispara "ended"/"mute"/"unmute" más tarde, esos listeners viejos
    // encontrarían la entrada NUEVA en `this.remoteSources.get(key)` (misma
    // key) y la purgarían/marcarían por error - un bug real que la revisión
    // de Codex encontró en una versión anterior de este mismo plan.
    track.addEventListener("ended", () => {
      if (this.remoteSources.get(key)?.track === track) this._removeRemoteSource(key, "track ended");
    });
    track.addEventListener("mute", () => {
      if (this.remoteSources.get(key)?.track === track) this._markStale(key);
    });
    track.addEventListener("unmute", () => {
      if (this.remoteSources.get(key)?.track === track) this._clearStale(key);
    });
    stream?.addEventListener("removetrack", (event) => {
      if (event.track === track && this.remoteSources.get(key)?.track === track) {
        this._removeRemoteSource(key, "removed from its MediaStream");
      }
    });

    this.log("remote-track-added", { key, connectionId, streamId: stream?.id ?? null, mid, trackId: track.id });
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

  startReconciliation(intervalMs = RECONCILE_INTERVAL_MS) {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => this.reconcile(), intervalMs);
  }

  stopReconciliation() {
    if (!this.reconcileTimer) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
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
    this.stopReconciliation();
    await this.audioContext.close();
  }
}
