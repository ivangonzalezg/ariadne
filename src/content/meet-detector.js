// src/content/meet-detector.js
import { SELECTORS } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { showBanner, updateBannerState } from "./meet-banner.js";
import { arrayBufferToBase64 } from "../lib/base64.js";

function isInActiveMeeting() {
  return document.querySelector(SELECTORS.hangUpButton) !== null;
}

function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function postToMainWorld(message) {
  window.postMessage({ source: "asterion-isolated-world", ...message }, "*");
}

let sessionId = null;
let currentState = "idle";

function setState(state) {
  currentState = state;
  updateBannerState(state);
}

function startRecording() {
  if (sessionId) return;
  sessionId = generateSessionId();
  setState("starting");

  // Avisar al service worker en paralelo (no después) para que el offscreen document
  // de storage exista antes de que lleguen los primeros chunks del bootstrap MAIN world —
  // si se esperara al primer "asterion:chunk" para crearlo, ese primer chunk se perdería.
  chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId });
  postToMainWorld({ type: "asterion:start-session", sessionId });

  observeMuteState((muted, timestampMs) => {
    postToMainWorld({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });

  enableCaptionsAndObserve((snapshot) => {
    chrome.runtime.sendMessage({ type: "asterion:caption-snapshot", sessionId, snapshot });
  });
}

function stopRecording() {
  if (!sessionId) return;
  postToMainWorld({ type: "asterion:stop-session", sessionId });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-main-world") return;

  if (message.type === "asterion:session-started") {
    setState("recording");
  } else if (message.type === "asterion:start-failed") {
    sessionId = null;
    setState("error");
    console.error("[Asterion] No se pudo iniciar la sesión:", message.reason);
  } else if (message.type === "asterion:chunk") {
    chrome.runtime.sendMessage({
      type: "asterion:chunk",
      sessionId: message.sessionId,
      stream: message.stream,
      seq: message.seq,
      bufferBase64: arrayBufferToBase64(message.buffer),
    });
  } else if (message.type === "asterion:video-enabled") {
    setState("video-enabled");
  } else if (message.type === "asterion:video-enable-failed") {
    updateBannerState(currentState, { videoError: message.message });
  } else if (message.type === "asterion:session-ended") {
    chrome.runtime.sendMessage({
      type: "asterion:session-ended",
      sessionId: message.sessionId,
      muteManifest: message.muteManifest,
    });
    sessionId = null;
    setState("idle");
  }
});

// El popup (Task 10) consulta el estado de esta pestaña y puede iniciar/detener desde ahí
// (no puede activar video: ese botón necesita el clic real en el banner de esta página —
// ver decisión del Task 6 sobre el gesto de usuario de getDisplayMedia).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "asterion:get-status") {
    sendResponse({ inMeeting: isInActiveMeeting(), state: currentState });
    return true;
  }
  if (message.type === "asterion:popup-start") {
    startRecording();
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "asterion:popup-stop") {
    stopRecording();
    sendResponse({ ok: true });
    return true;
  }
});

// Si la pestaña se cierra o navega fuera con una sesión activa, avisarle al bootstrap
// MAIN world para que finalice y emita lo que alcanzó a grabar (PRD 5.8).
window.addEventListener("pagehide", () => {
  if (sessionId) postToMainWorld({ type: "asterion:stop-session", sessionId });
});

function waitForMeeting() {
  const observer = new MutationObserver(() => {
    if (isInActiveMeeting()) {
      observer.disconnect();
      chrome.storage.local.get({ autoStart: true }, ({ autoStart }) => {
        showBanner({ onStart: startRecording, onStop: stopRecording });
        if (autoStart) startRecording();
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

waitForMeeting();
