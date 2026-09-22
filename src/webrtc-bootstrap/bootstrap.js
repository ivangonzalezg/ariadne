// src/webrtc-bootstrap/bootstrap.js
import { installRtcPatch, installGetUserMediaPatch, diagnostics } from "./rtc-patch.js";
import { MeetingAudioMixer } from "./audio-mixer.js";
import { MainWorldSession } from "./session.js";

console.log("[Asterion:debug] bootstrap (MAIN world) cargado");

const mixer = new MeetingAudioMixer({
  log: (event, details) => console.debug(`[Asterion:audio-mixer] ${event}`, details),
});
mixer.resume().catch(() => {});
let micTrack = null;
let session = null;

installRtcPatch({
  onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
  onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
  log: (event, details) => console.debug(`[Asterion:rtc-patch] ${event}`, details),
});

installGetUserMediaPatch({
  onMicStream: (stream, audioTrack) => {
    micTrack = audioTrack;
  },
});

function postToIsolated(message, transfer = []) {
  window.postMessage({ source: "asterion-main-world", ...message }, "*", transfer);
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-isolated-world") return;

  console.log("[Asterion:debug] mensaje recibido desde ISOLATED world", { type: message.type });

  if (message.type === "asterion:start-session") {
    console.log("[Asterion:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {
      sessionId: message.sessionId,
      mixer,
      session,
    });
    if (!micTrack) {
      postToIsolated({ type: "asterion:start-failed", sessionId: message.sessionId, reason: "no-mic-stream" });
      return;
    }
    mixer.setMicTrack(micTrack, { initiallyMuted: Boolean(message.initialMicMuted) });
    console.log("[Asterion] AudioContext state antes de resume():", mixer.audioContext.state);
    await mixer.resume();
    console.log("[Asterion] AudioContext state después de resume():", mixer.audioContext.state);
    session = new MainWorldSession({
      sessionId: message.sessionId,
      mixer,
      postToIsolated,
      initialMicMuted: Boolean(message.initialMicMuted),
    });
    session.start();
    mixer.startReconciliation();
    postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });
  } else if (message.type === "asterion:mic-muted") {
    session?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    session?.onMicUnmuted(message.timestampMs);
  } else if (message.type === "asterion:stop-session") {
    session?.stop();
    session = null;
    mixer.stopReconciliation();
  }
});

document.addEventListener(
  "click",
  async (event) => {
    const target = event.composedPath().find((el) => el instanceof Element && el.matches("[data-asterion-enable-video]"));
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
