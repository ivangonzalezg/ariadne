// src/webrtc-bootstrap/session.js
import { MuteManifest } from "../lib/mute-manifest.js";

const CHUNK_TIMESLICE_MS = 2000;

export class MainWorldSession {
  constructor({ sessionId, mixer, postToIsolated, initialMicMuted, onChunk = () => {}, onRecorderError = () => {} }) {
    this.sessionId = sessionId;
    this.onChunk = onChunk;
    this.onRecorderError = onRecorderError;
    this.generation = 0;
    this.committedChunks = 0;
    this.confirmedSequences = new Map();
    this.receivedChunks = 0;
    this.stopping = false;
    this.restartPromise = null;
    this.recorderStops = new WeakMap();
    this.mixer = mixer;
    this.mixer.setMicMuted(Boolean(initialMicMuted), { immediate: true });
    this.postToIsolated = postToIsolated;
    this.muteManifest = new MuteManifest({ startedAt: Date.now() });
    this.seq = { meeting: 0, video: 0 };
    this.videoRecorder = null;
    this.videoStream = null;
    this._meetingWrites = null;
    this._videoWrites = null;

    if (!initialMicMuted) {
      this.muteManifest.onUnmuted(Date.now());
    }
  }

  start() {
    const { recorder, waitForPendingWrites } = this._startRecorder(this.mixer.stream, "meeting", "audio/webm");
    this.meetingRecorder = recorder;
    this._meetingWrites = waitForPendingWrites;
  }

  _startRecorder(stream, streamLabel, mimeType) {
    const recorder = new MediaRecorder(stream, { mimeType });
    const generation = this.generation;
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    this.recorderStops.set(recorder, stopped);
    recorder.onerror = (event) => { if (!this.stopping) this.onRecorderError(event.error); };
    // Cadena secuencial: cada chunk espera a que el anterior termine de procesarse
    // y mandarse antes de seguir - evita que lleguen desordenados, y stop() puede
    // esperar a que esta cadena termine para saber que el último chunk ya salió.
    let writeChain = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (streamLabel === "meeting") this.onChunk(event.data.size);
      if (event.data.size === 0) return;
      this.receivedChunks++;
      const captureTs = Date.now();
      this.seq[streamLabel] += 1;
      const seq = this.seq[streamLabel];
      writeChain = writeChain.then(async () => {
        const buffer = await event.data.arrayBuffer();
        await this.postToIsolated(
          { type: "asterion:chunk", sessionId: this.sessionId, stream: streamLabel, seq, generation, captureTs, buffer },
          [buffer]
        );
      });
    };
    recorder.start(CHUNK_TIMESLICE_MS);
    return { recorder, waitForPendingWrites: () => writeChain };
  }

  confirmChunk({ sessionId, stream, seq, generation }) {
    if (sessionId !== this.sessionId || !Object.hasOwn(this.seq, stream) || generation > this.generation || !Number.isInteger(seq) || seq < 1 || seq > this.seq[stream]) return;
    const key = `${stream}:${generation}:${seq}`;
    if (this.confirmedSequences.has(key)) return;
    this.confirmedSequences.set(key, true);
    this.committedChunks++;
  }

  checkpoint(generationClosed = false) {
    return this.postToIsolated({ type: "asterion:session-checkpoint", sessionId: this.sessionId,
      muteManifest: { ...this.muteManifest.toJSON(), openIntervalStartMs: this.muteManifest.openIntervalStartMs, checkpointAt: Date.now() }, expectedSequences: { ...this.seq }, generation: this.generation, generationClosed });
  }

  onMicMuted(timestampMs) {
    this.muteManifest.onMuted(timestampMs);
    this.mixer.setMicMuted(true);
    this.checkpoint();
  }

  onMicUnmuted(timestampMs) {
    this.muteManifest.onUnmuted(timestampMs);
    this.mixer.setMicMuted(false);
    this.checkpoint();
  }

  enableVideo(displayStream) {
    if (this.videoRecorder) return;
    this.videoStream = displayStream;

    const videoTrack = displayStream.getVideoTracks()[0];
    const audioTrack = this.mixer.stream.getAudioTracks()[0];
    const recordedStream = new MediaStream(
      audioTrack ? [videoTrack, audioTrack] : [videoTrack]
    );

    const { recorder, waitForPendingWrites } = this._startRecorder(recordedStream, "video", "video/webm");
    this.videoRecorder = recorder;
    this._videoWrites = waitForPendingWrites;
  }

  async _flushRecorders() {
    const recorders = [this.meetingRecorder, this.videoRecorder].filter(Boolean);
    await Promise.all(recorders.map((recorder) => {
      if (recorder.state !== "inactive") recorder.stop();
      return this.recorderStops.get(recorder);
    }));
    await Promise.all([this._meetingWrites?.(), this._videoWrites?.()].filter(Boolean));
  }

  restart(createMixer) {
    if (this.stopping) return Promise.resolve(false);
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      await this._flushRecorders();
      await this.checkpoint(true);
      if (this.stopping) return false;
      const mixer = await createMixer();
      if (this.stopping) { await mixer.close?.(); return false; }
      this.mixer = mixer;
      this.generation++;
      this.videoRecorder = null;
      this.start();
      if (this.videoStream) this.enableVideo(this.videoStream);
      return true;
    })().finally(() => { this.restartPromise = null; });
    return this.restartPromise;
  }

  async stop({ interruptionReason = null } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const endedAt = Date.now();
    this.muteManifest.finalize(endedAt);
    this.stopPromise = (async () => {
      await this.restartPromise;
      await this._flushRecorders();
      this.videoStream?.getTracks().forEach((track) => track.stop());
      await this.postToIsolated({ type: "asterion:session-ended", sessionId: this.sessionId,
        muteManifest: this.muteManifest.toJSON(), endedAt, expectedSequences: { ...this.seq }, interruptionReason });
    })();
    return this.stopPromise;
  }
}
