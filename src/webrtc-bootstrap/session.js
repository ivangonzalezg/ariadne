// src/webrtc-bootstrap/session.js
import { MuteManifest } from "../lib/mute-manifest.js";

const CHUNK_TIMESLICE_MS = 1000;

export class MainWorldSession {
  constructor({ sessionId, remoteAudioStream, micStream, postToIsolated }) {
    this.sessionId = sessionId;
    this.remoteAudioStream = remoteAudioStream;
    this.micStream = micStream;
    this.postToIsolated = postToIsolated;
    this.muteManifest = new MuteManifest({ startedAt: Date.now() });
    this.seq = { meeting: 0, mic: 0, video: 0 };
    this.videoRecorder = null;
    this.videoStream = null;
  }

  start() {
    this.meetingRecorder = this._startRecorder(this.remoteAudioStream, "meeting");
    this.micRecorder = this._startRecorder(this.micStream, "mic");
  }

  _startRecorder(stream, streamLabel) {
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorder.ondataavailable = async (event) => {
      if (event.data.size === 0) return;
      const buffer = await event.data.arrayBuffer();
      this.seq[streamLabel] += 1;
      this.postToIsolated(
        {
          type: "asterion:chunk",
          sessionId: this.sessionId,
          stream: streamLabel,
          seq: this.seq[streamLabel],
          buffer,
        },
        [buffer]
      );
    };
    recorder.start(CHUNK_TIMESLICE_MS);
    return recorder;
  }

  onMicMuted(timestampMs) {
    this.muteManifest.onMuted(timestampMs);
    if (this.micRecorder?.state === "recording") this.micRecorder.pause();
  }

  onMicUnmuted(timestampMs) {
    this.muteManifest.onUnmuted(timestampMs);
    if (this.micRecorder?.state === "paused") this.micRecorder.resume();
  }

  enableVideo(displayStream) {
    if (this.videoRecorder) return;
    this.videoStream = displayStream;
    this.videoRecorder = this._startRecorder(displayStream, "video");
  }

  async stop() {
    this.muteManifest.finalize(Date.now());
    const recorders = [this.meetingRecorder, this.micRecorder, this.videoRecorder].filter(Boolean);
    recorders.forEach((r) => r.stop());
    await Promise.all(
      recorders.map(
        (r) =>
          new Promise((resolve) => {
            r.onstop = resolve;
          })
      )
    );
    this.videoStream?.getTracks().forEach((t) => t.stop());

    this.postToIsolated({
      type: "asterion:session-ended",
      sessionId: this.sessionId,
      muteManifest: this.muteManifest.toJSON(),
    });
  }
}
