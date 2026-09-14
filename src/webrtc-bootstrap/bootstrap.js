// src/webrtc-bootstrap/bootstrap.js
import { installRtcPatch, installGetUserMediaPatch, diagnostics } from "./rtc-patch.js";
import { MeetingAudioMixer } from "./audio-mixer.js";
import { MainWorldSession } from "./session.js";

const mixer = new MeetingAudioMixer();
let micTrack = null;
let session = null;

installRtcPatch({
  onRemoteAudioTrack: (track) => mixer.addRemoteTrack(track),
  onConnectionClosed: () => {},
});

installGetUserMediaPatch({
  onMicStream: (stream, audioTrack) => {
    micTrack = audioTrack;
  },
});

function postToIsolated(message, transfer = []) {
  window.postMessage({ source: "asterion-main-world", ...message }, "*", transfer);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-isolated-world") return;

  if (message.type === "asterion:start-session") {
    if (!micTrack) {
      postToIsolated({ type: "asterion:start-failed", sessionId: message.sessionId, reason: "no-mic-stream" });
      return;
    }
    mixer.setMicTrack(micTrack, { initiallyMuted: Boolean(message.initialMicMuted) });
    session = new MainWorldSession({
      sessionId: message.sessionId,
      mixer,
      postToIsolated,
      initialMicMuted: Boolean(message.initialMicMuted),
    });
    session.start();
    postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });
  } else if (message.type === "asterion:mic-muted") {
    session?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    session?.onMicUnmuted(message.timestampMs);
  } else if (message.type === "asterion:stop-session") {
    session?.stop();
    session = null;
  }
});

document.addEventListener(
  "click",
  async (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-asterion-enable-video]") : null;
    if (!target || !session) return;

    console.log("[Asterion] userActivation.isActive antes de getDisplayMedia:", navigator.userActivation?.isActive);

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        preferCurrentTab: true,
      });
      session.enableVideo(displayStream);
      postToIsolated({ type: "asterion:video-enabled", sessionId: session.sessionId });
    } catch (error) {
      postToIsolated({
        type: "asterion:video-enable-failed",
        sessionId: session.sessionId,
        message: error.message,
      });
    }
  },
  true
);

window.__asterionDiagnostics = diagnostics;
