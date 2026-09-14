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
let stopMuteObserver = () => {};
let stopCaptionObserver = () => {};

function setState(state) {
  currentState = state;
  updateBannerState(state);
}

function cleanupObservers() {
  stopMuteObserver();
  stopCaptionObserver();
  stopMuteObserver = () => {};
  stopCaptionObserver = () => {};
}

async function startRecording() {
  if (sessionId) return;
  sessionId = generateSessionId();
  setState("starting");

  chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId });

  let isFirstMuteReport = true;

  // observeMuteState informa el estado actual de forma síncrona en su primera
  // llamada — se aprovecha eso para mandar "start-session" recién ahí, con el
  // estado real de mute ya conocido (el GainNode del mic necesita arrancar en
  // el valor correcto desde el primer instante, ver Task 13 del plan).
  stopMuteObserver = observeMuteState((muted, timestampMs) => {
    if (isFirstMuteReport) {
      isFirstMuteReport = false;
      postToMainWorld({ type: "asterion:start-session", sessionId, initialMicMuted: muted });
      return;
    }
    postToMainWorld({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });

  const cleanup = await enableCaptionsAndObserve((snapshot) => {
    chrome.runtime.sendMessage({ type: "asterion:caption-snapshot", sessionId, snapshot });
  });
  stopCaptionObserver = cleanup ?? (() => {});
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
    cleanupObservers();
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
    cleanupObservers();
  }
});

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
