import { sweepRemoteAudioTracks } from "./rtc-patch.js";

const SAMPLE_INTERVAL_MS = 500;
const SUMMARY_INTERVAL_MS = 30000;

// Session diagnostics contain metadata and levels, never audio samples.
export class RemoteAudioMonitor {
  constructor({ mixer, playbackObserver = null, sweep = sweepRemoteAudioTracks, now = () => Date.now(), log = () => {} }) {
    this.mixer = mixer;
    this.playbackObserver = playbackObserver;
    this.sweep = sweep;
    this.now = now;
    this.log = log;
    this.sampleTimer = null;
    this.sessionId = null;
    this.sampledAt = null;
    this.lastSweep = null;
    this.recoveries = 0;
    this.errorCount = 0;
    this.lastError = null;
    this.lastState = null;
    this.lastSummaryAt = null;
  }

  addRemoteTrack(payload) {
    try {
      return this.mixer.addRemoteTrack(payload);
    } catch (error) {
      this._recordError({ connectionId: payload.connectionId, trackId: payload.track.id, operation: "track-event", message: String(error.message ?? error) });
      return "error";
    }
  }

  _recordError(error) {
    if (this.sessionId !== null) {
      this.errorCount += 1;
      this.lastError = { ...error, timestamp: this.now() };
    }
    this.log("remote-audio-error", error);
  }

  _scan() {
    const recoveredKeys = new Set();
    const result = this.sweep({ onRemoteAudioTrack: (payload) => {
      const status = this.mixer.addRemoteTrack({ ...payload, deferConnection: true });
      if (["added", "reconnected"].includes(status)) recoveredKeys.add(this.mixer.trackKeys?.get(payload.track) ?? `${payload.connectionId}:${payload.track.id}`);
      return status;
    } });
    const reconciliation = this.mixer.reconcileRemoteSources?.() ?? { recovered: 0, errors: [] };
    result.discovered = result.recovered;
    if (this.mixer.reconcileRemoteSources) {
      for (const key of reconciliation.keys) recoveredKeys.add(key);
      result.recovered = recoveredKeys.size;
    }
    result.errors.push(...reconciliation.errors);
    this.lastSweep = { phases: ["discovery", "reconciliation"], timestamp: this.now(), ...result };
    this.recoveries += result.recovered;
    for (const error of result.errors) this._recordError(error);
    if (result.recovered) this.log("remote-audio-recovered", { recovered: result.recovered });
  }

  _sample() {
    this.playbackObserver?.sample();
    for (const error of this.mixer.sampleRemoteAudio()) this._recordError(error);
    this.sampledAt = this.now();
    const snapshot = this.getRemoteAudioSnapshot();
    const state = JSON.stringify({
      audioContextState: snapshot.audioContextState,
      recordingType: this.mixer.recordingType,
      captureRoute: snapshot.captureRoute,
      playbackOutputs: snapshot.playback?.outputs.map(({ key, nodeType, contextState, rms }) => ({ key, nodeType, contextState, signal: rms === null ? "unavailable" : rms > 0.001 ? "observed" : "silence" })),
      tracks: snapshot.tracks.map(({ key, readyState, muted, enabled, captureEnabled, connectedToMixer, rms }) => ({
        key, readyState, muted, enabled, captureEnabled, connectedToMixer,
        signal: rms === null ? "unavailable" : rms > 0.001 ? "observed" : "silence",
      })),
    });
    if (state !== this.lastState) {
      this.lastState = state;
      this.log("remote-audio-state-changed", snapshot);
    }
    if (this.lastSummaryAt === null || this.sampledAt - this.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      this.lastSummaryAt = this.sampledAt;
      this.log("remote-audio-summary", snapshot);
    }
  }

  start(sessionId, { managed = false, preserveSession = false } = {}) {
    this.stop();
    this.sessionId = sessionId;
    if (!preserveSession) {
      this.sampledAt = null;
      this.lastSweep = null;
      this.recoveries = 0;
      this.errorCount = 0;
      this.lastError = null;
      this.lastState = null;
      this.lastSummaryAt = null;
    }
    this.mixer.startRemoteAnalysis();
    this.playbackObserver?.start();
    this.mixer.reconcile();
    this._scan();
    this._sample();
    if (!managed) this.mixer.startReconciliation(5000, () => this._scan());
    this.sampleTimer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
  }

  stop() {
    if (this.sampleTimer !== null) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    this.mixer.stopReconciliation();
    this.mixer.stopRemoteAnalysis();
    this.playbackObserver?.stop();
    this.sessionId = null;
  }

  getRemoteAudioSnapshot() {
    return {
      sessionId: this.sessionId, sampledAt: this.sampledAt,
      audioContextState: this.mixer.audioContext.state,
      recordingType: this.mixer.recordingType,
      captureRoute: this.mixer.remoteRoute,
      lastSweep: this.lastSweep === null ? null : structuredClone(this.lastSweep),
      recoveries: this.recoveries, errorCount: this.errorCount,
      lastError: this.lastError === null ? null : { ...this.lastError },
      tracks: this.mixer.getRemoteAudioSnapshot(),
      playback: this.playbackObserver?.getSnapshot() ?? null,
    };
  }
}
