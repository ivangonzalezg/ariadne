// src/webrtc-bootstrap/audio-mixer.js
import { measureAudioSamples } from "./audio-levels.js";
const RECONCILE_INTERVAL_MS = 5000;

export class MeetingAudioMixer {
  constructor({ audioContext = new AudioContext(), recordingType = "hybrid", now = () => Date.now(), log = () => {} } = {}) {
    this.audioContext = audioContext;
    this.now = now;
    this.log = log;
    this.destination = this.audioContext.createMediaStreamDestination();
    this._forceStereoChannelConfig(this.destination, "destination");
    // key -> { connectionId, sourceNode, track, staleSince }
    this.remoteSources = new Map();
    this.playbackSources = new Map();
    this.recordingType = recordingType;
    this.remoteRoute = recordingType;
    this.htmlSources = new Map();
    this.localSources = new Map();
    this.localOwners = new Map();
    this.connectionStates = new Map();
    this.trackKeys = new Map();
    this.supersededTracks = new WeakSet();
    this.analysisEnabled = false;
    // connectionId -> Set<key>, for O(1) purge-by-connection
    this.connectionKeys = new Map();
    this.micSourceNode = null;
    this.micGainNode = null;
    this.reconcileTimer = null;
  }

  // Keep the destination channel layout stable across reconstructed pipelines.
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

  addRemoteTrack({ track, stream, mid, connectionId, receiver, discovery = "event", deferConnection = false }) {
    if (this.supersededTracks.has(track)) return "superseded";
    const previousKey = this.trackKeys.get(track);
    const previous = this.remoteSources.get(previousKey);
    let key = this._remoteKey(connectionId, { streamId: stream?.id ?? null, mid, track });
    // A sweep may know less than a prior event: never downgrade its identity.
    if (previous && !stream && (previousKey.startsWith("stream:") || !mid)) key = previousKey;
    const existing = this.remoteSources.get(key);
    if (existing && existing.track !== track && existing.connectionId > connectionId) {
      this.supersededTracks.add(track);
      if (previous) this._teardownEntry(previousKey, previous, "displaced by a newer connection");
      return "superseded";
    }
    const replaceExisting = () => {
      if (existing && existing.track !== track) {
        this.supersededTracks.add(existing.track);
        this._teardownEntry(key, existing, "replaced by a newer track for the same slot");
      }
    };
    if (previous) {
      previous.receiver = receiver ?? previous.receiver;
      replaceExisting();
      if (key !== previousKey) {
        this.remoteSources.delete(previousKey);
        const keys = this.connectionKeys.get(previous.connectionId);
        keys.delete(previousKey);
        keys.add(key);
        this.remoteSources.set(key, previous);
        this.trackKeys.set(track, key);
      }
      this._observeStream(previous, stream);
      const reconnected = discovery === "sweep" && !deferConnection && this._connectReceiver(key, previous);
      return reconnected ? "reconnected" : "unchanged";
    }

    // Keep recording independent of Meet's per-track `enabled` controls.
    // Muting the actual remote source still affects every clone; only our own
    // copy is enabled here. Identity and lifecycle remain tied to Meet's track.
    const captureTrack = track.clone();
    let sourceNode;
    try {
      captureTrack.enabled = true;
      sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([captureTrack]));
      if (this.recordingType === "webrtc") sourceNode.connect(this.destination);
    } catch (error) {
      sourceNode?.disconnect();
      captureTrack.stop();
      throw error;
    }

    // Commit a replacement only after the new source connected successfully.
    replaceExisting();
    const entry = { receiver, connectionId, sourceNode, track, captureTrack, staleSince: null, stream: null, listeners: [], connectedToMixer: this.recordingType === "webrtc", analyser: null, samples: null, rms: null, peak: null, lastSignalAt: null };
    this.remoteSources.set(key, entry);
    this.trackKeys.set(track, key);

    let keysForConnection = this.connectionKeys.get(connectionId);
    if (!keysForConnection) {
      keysForConnection = new Set();
      this.connectionKeys.set(connectionId, keysForConnection);
    }
    keysForConnection.add(key);

    const listen = (type, handler) => {
      track.addEventListener(type, handler);
      entry.listeners.push([type, handler]);
    };
    listen("ended", () => {
      const currentKey = this.trackKeys.get(track);
      if (currentKey) this._removeRemoteSource(currentKey, "track ended");
    });
    listen("mute", () => {
      const currentKey = this.trackKeys.get(track);
      if (currentKey) this._markStale(currentKey);
    });
    listen("unmute", () => {
      const currentKey = this.trackKeys.get(track);
      if (currentKey) this._clearStale(currentKey);
    });
    this._observeStream(entry, stream);
    if (discovery === "sweep" && !deferConnection) this._connectReceiver(key, entry);
    this.log("remote-track-added", { key, connectionId, streamId: stream?.id ?? null, mid, trackId: track.id });
    return "added";
  }

  _observeStream(entry, stream) {
    if (!stream || entry.stream === stream) return;
    entry.stream?.removeEventListener?.("removetrack", entry.onRemoveTrack);
    entry.stream = stream;
    entry.onRemoveTrack = (event) => {
      const key = this.trackKeys.get(entry.track);
      if (event.track === entry.track && key) this._removeRemoteSource(key, "removed from its MediaStream");
    };
    stream.addEventListener?.("removetrack", entry.onRemoveTrack);
  }

  removeConnection(connectionId) {
    const keys = this.connectionKeys.get(connectionId);
    for (const [sender, owner] of this.localOwners) {
      if (owner.connectionId === connectionId) this.setLocalSender(sender, null, connectionId);
    }
    if (!keys) return;
    for (const key of [...keys]) this._removeRemoteSource(key, "connection closed");
    this.connectionKeys.delete(connectionId);
  }

  reconcile() {
    for (const [key, entry] of [...this.remoteSources]) {
      if (entry.track.readyState !== "live") {
        this._removeRemoteSource(key, "reconcile: track not live");
        continue;
      }
      // `mute` is temporary: a live track can resume without another `track`
      // event. Keep its node connected so recovery reaches the recorder.
    }
  }

  reconcileRemoteSources() {
    const result = { recovered: 0, errors: [], keys: [] };
    for (const [key, entry] of this.remoteSources) {
      try { if (this._connectReceiver(key, entry)) { result.recovered++; result.keys.push(key); } }
      catch (error) { result.errors.push({ key, operation: "reconcileRemoteSources", message: error.message }); }
    }
    return result;
  }

  reconcileLocalOwners(connectionId, senders) {
    for (const [sender, owner] of this.localOwners) {
      if (owner.connectionId === connectionId && !senders.includes(sender)) this.setLocalSender(sender, null);
    }
  }

  setLocalSender(sender, track, connectionId = this.localOwners.get(sender)?.connectionId) {
    const previous = this.localOwners.get(sender);
    if (track?.kind === "audio" && track.readyState === "live") {
      this.localOwners.set(sender, { track, connectionId });
      this.addLocalTrack(track);
    } else this.localOwners.delete(sender);
    if (previous && ![...this.localOwners.values()].some((owner) => owner.track === previous.track)) {
      this.removeLocalTrack(previous.track.id);
    }
  }

  startReconciliation(intervalMs = RECONCILE_INTERVAL_MS, afterReconcile = () => {}) {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      this.reconcile();
      afterReconcile();
    }, intervalMs);
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
    const mutedForMs = entry.staleSince === null ? null : this.now() - entry.staleSince;
    entry.staleSince = null;
    this.log("remote-track-unmuted", { key, mutedForMs });
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
    this._disconnectAnalyser(entry);
    entry.captureTrack.stop();
    for (const [type, handler] of entry.listeners) entry.track.removeEventListener?.(type, handler);
    entry.stream?.removeEventListener?.("removetrack", entry.onRemoveTrack);
    this.trackKeys.delete(entry.track);
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

  startRemoteAnalysis() {
    this.analysisEnabled = true;
    for (const entry of this.remoteSources.values()) entry.lastSignalAt = null;
  }

  _disconnectAnalyser(entry) {
    if (entry.analyser) {
      try { entry.sourceNode.disconnect(entry.analyser); } catch { /* source may already be disconnected */ }
      entry.analyser.disconnect();
    }
    entry.analyser = null;
    entry.samples = null;
    entry.rms = null;
    entry.peak = null;
  }

  stopRemoteAnalysis() {
    this.analysisEnabled = false;
    for (const entry of this.remoteSources.values()) this._disconnectAnalyser(entry);
  }

  sampleRemoteAudio() {
    const errors = [];
    for (const [key, entry] of this.remoteSources) {
      entry.rms = null;
      entry.peak = null;
      if (!this.analysisEnabled || this.audioContext.state !== "running") continue;
      try {
        if (!entry.analyser) {
          const analyser = this.audioContext.createAnalyser();
          analyser.fftSize = 2048;
          try { entry.sourceNode.connect(analyser); }
          catch (error) { analyser.disconnect(); throw error; }
          entry.analyser = analyser;
          entry.samples = new Float32Array(analyser.fftSize);
        }
        entry.analyser.getFloatTimeDomainData(entry.samples);
        Object.assign(entry, measureAudioSamples(entry.samples));
        if (entry.rms > 0.001) entry.lastSignalAt = this.now();
      } catch (error) {
        this._disconnectAnalyser(entry);
        errors.push({ key, operation: "sampleRemoteAudio", message: String(error.message ?? error) });
      }
    }
    return errors;
  }

  getRemoteAudioSnapshot() {
    const available = this.analysisEnabled && this.audioContext.state === "running";
    return [...this.remoteSources].map(([key, entry]) => ({
      key, connectionId: entry.connectionId, trackId: entry.track.id,
      readyState: entry.track.readyState, muted: Boolean(entry.track.muted),
      enabled: entry.track.enabled, captureTrackId: entry.captureTrack.id, captureEnabled: entry.captureTrack.enabled,
      connectedToMixer: entry.connectedToMixer,
      effectiveSource: this.htmlSources.has(entry.stream?.id) ? "html" : entry.connectedToMixer ? "receiver" : null,
      rms: available ? entry.rms : null, peak: available ? entry.peak : null,
      lastSignalAt: entry.lastSignalAt, announcedMicOn: entry.announcedMicOn ?? null,
    }));
  }

  addPlaybackStream(key, stream) {
    if (this.recordingType !== "hybrid" || this.playbackSources.has(key)) return;
    const source = this.audioContext.createMediaStreamSource(stream);
    try { source.connect(this.destination); }
    catch (error) { source.disconnect(); throw error; }
    this.playbackSources.set(key, source);
  }

  removePlaybackStream(key) {
    const source = this.playbackSources.get(key);
    if (!source) return;
    source.disconnect();
    this.playbackSources.delete(key);
  }

  _connectReceiver(key, entry) {
    if (entry.connectedToMixer || this.recordingType === "html" || ["closed", "failed"].includes(this.connectionStates.get(entry.connectionId))) return;
    if (this.htmlSources.has(entry.stream?.id)) return;
    // Event discovery only registers hybrid receivers; sweeps also repair
    // missing healthy sources. Silence is never used to choose a route.
    if (entry.track.readyState === "live" && !entry.track.muted && entry.track.enabled) {
      entry.sourceNode.connect(this.destination);
      entry.connectedToMixer = true;
      this.log("remote-source-reconnected", { key, connectionId: entry.connectionId });
      return true;
    }
    return false;
  }

  reconnectRemoteStream(key) {
    const entry = this.remoteSources.get(key);
    if (!entry) return false;
    const htmlSource = this.htmlSources.get(entry.stream?.id);
    if (!htmlSource && !entry.connectedToMixer) return false;
    const stream = htmlSource ? entry.stream : new MediaStream([entry.captureTrack]);
    const source = this.audioContext.createMediaStreamSource(stream);
    try { source.connect(this.destination); }
    catch (error) { source.disconnect(); throw error; }
    if (htmlSource) {
      htmlSource.disconnect();
      this.htmlSources.set(entry.stream.id, source);
    } else {
      this._disconnectAnalyser(entry);
      entry.sourceNode.disconnect();
      entry.sourceNode = source;
    }
    return true;
  }

  addHtmlStream(stream) {
    if (this.recordingType === "webrtc" || this.htmlSources.has(stream.id)) return;
    const remote = this.remoteSources.get(`stream:${stream.id}`);
    if (remote?.connectedToMixer) return;
    const source = this.audioContext.createMediaStreamSource(stream);
    try { source.connect(this.destination); }
    catch (error) { source.disconnect(); throw error; }
    this.htmlSources.set(stream.id, source);
  }

  removeHtmlStream(id) {
    this.htmlSources.get(id)?.disconnect();
    this.htmlSources.delete(id);
  }

  addLocalTrack(track) {
    if (this.localSources.has(track.id) || track.readyState !== "live") return;
    if (!this.micGainNode) {
      this.micGainNode = this.audioContext.createGain();
      this.micGainNode.gain.value = this.micMuted ? 0 : 1;
      this.micGainNode.connect(this.destination);
    }
    const source = this.audioContext.createMediaStreamSource(new MediaStream([track]));
    source.connect(this.micGainNode);
    const ended = () => this.removeLocalTrack(track.id);
    track.addEventListener?.("ended", ended);
    this.localSources.set(track.id, { track, source, ended });
  }

  removeLocalTrack(id) {
    const entry = this.localSources.get(id);
    if (!entry) return;
    entry.source.disconnect();
    entry.track.removeEventListener?.("ended", entry.ended);
    this.localSources.delete(id);
  }

  getLocalSnapshot() {
    return [...this.localSources.values()].map(({ track }) => ({ trackId: track.id,
      readyState: track.readyState, enabled: track.enabled, muted: track.muted,
      senderReferences: [...this.localOwners.values()].filter((owner) => owner.track === track).length }));
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

  setMicMuted(muted, { immediate = false } = {}) {
    this.micMuted = muted;
    if (!this.micGainNode) return;
    const now = this.audioContext.currentTime;
    const targetGain = muted ? 0 : 1;
    // Rampa corta en vez de asignar gain.value directo - evita un "click" audible
    // en la transición.
    this.micGainNode.gain.cancelScheduledValues(now);
    if (immediate) {
      this.micGainNode.gain.setValueAtTime(targetGain, now);
      this.micGainNode.gain.value = targetGain;
      return;
    }
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
    this.stopRemoteAnalysis();
    for (const key of [...this.remoteSources.keys()]) this._removeRemoteSource(key, "mixer closed");
    for (const key of [...this.playbackSources.keys()]) this.removePlaybackStream(key);
    for (const id of [...this.htmlSources.keys()]) this.removeHtmlStream(id);
    for (const id of [...this.localSources.keys()]) this.removeLocalTrack(id);
    this.localOwners.clear(); this.connectionStates.clear();
    if (this.audioContext.state !== "closed") await this.audioContext.close();
  }
}
