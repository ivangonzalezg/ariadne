// src/webrtc-bootstrap/session.js
import { MuteManifest } from "../lib/mute-manifest.js";

const CHUNK_TIMESLICE_MS = 1000;

export class MainWorldSession {
  constructor({ sessionId, mixer, postToIsolated, initialMicMuted }) {
    this.sessionId = sessionId;
    this.mixer = mixer;
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
    // Cadena secuencial: cada chunk espera a que el anterior termine de procesarse
    // y mandarse antes de seguir — evita que lleguen desordenados, y stop() puede
    // esperar a que esta cadena termine para saber que el último chunk ya salió.
    let writeChain = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.seq[streamLabel] += 1;
      const seq = this.seq[streamLabel];
      writeChain = writeChain.then(async () => {
        const buffer = await event.data.arrayBuffer();
        this.postToIsolated(
          { type: "asterion:chunk", sessionId: this.sessionId, stream: streamLabel, seq, buffer },
          [buffer]
        );
      });
    };
    recorder.start(CHUNK_TIMESLICE_MS);
    return { recorder, waitForPendingWrites: () => writeChain };
  }

  onMicMuted(timestampMs) {
    this.muteManifest.onMuted(timestampMs);
    this.mixer.setMicMuted(true);
  }

  onMicUnmuted(timestampMs) {
    this.muteManifest.onUnmuted(timestampMs);
    this.mixer.setMicMuted(false);
  }

  enableVideo(displayStream) {
    if (this.videoRecorder) return;
    this.videoStream = displayStream;
    // Bug corregido: antes se forzaba "audio/webm" también para el stream de video.
    const { recorder, waitForPendingWrites } = this._startRecorder(displayStream, "video", "video/webm");
    this.videoRecorder = recorder;
    this._videoWrites = waitForPendingWrites;
  }

  async stop() {
    this.muteManifest.finalize(Date.now());
    const recorders = [this.meetingRecorder, this.videoRecorder].filter(Boolean);

    const stopped = recorders.map(
      (r) =>
        new Promise((resolve) => {
          r.onstop = resolve;
        })
    );
    recorders.forEach((r) => r.stop());
    await Promise.all(stopped);

    // Esperar a que el último chunk (el que dispara el evento "stop") termine de
    // procesarse y enviarse — si no, se podía señalar el fin de sesión antes de
    // que ese último pedazo de audio/video llegara al offscreen document.
    await Promise.all([this._meetingWrites?.(), this._videoWrites?.()].filter(Boolean));

    this.videoStream?.getTracks().forEach((t) => t.stop());

    this.postToIsolated({
      type: "asterion:session-ended",
      sessionId: this.sessionId,
      muteManifest: this.muteManifest.toJSON(),
    });
  }
}
