// src/content/meet-detector.js
import { findByIconText } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { showBanner, showFinishedBanner, updateBannerState } from "./meet-banner.js";
import { arrayBufferToBase64 } from "../lib/base64.js";
import { debugLog, isDebugEnabled, setDebugEnabled } from "../shared/debug-log.js";

const debugLoggingReady = chrome.storage.local.get({ debugLogging: false }).then(({ debugLogging }) => {
  setDebugEnabled(debugLogging);
  debugLog("[Ariadne:debug] content script (ISOLATED) cargado", { url: location.href });
});

function isInActiveMeeting() {
  return findByIconText("call_end") !== null;
}

function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function postToMainWorld(message) {
  window.postMessage({ source: "asterion-isolated-world", ...message }, "*");
}

let sessionId = null;
let currentState = "idle";
let meetingTitle = null;
let startedAt = null;
let hasTranscript = false;
let micMuted = true;
let videoEnabled = false;
let stopMuteObserver = () => {};
let stopCaptionObserver = () => {};

function bannerMeta(extra = {}) {
  return { meetingTitle, startedAt, hasTranscript, micMuted, videoEnabled, ...extra };
}

function setState(state, meta = {}) {
  currentState = state;
  updateBannerState(state, bannerMeta(meta));
}

function cleanupObservers() {
  stopMuteObserver();
  stopCaptionObserver();
  stopMuteObserver = () => {};
  stopCaptionObserver = () => {};
}

function getCurrentMeetingTitle() {
  return document.title && document.title.trim() && document.title.trim() !== "Meet"
    ? document.title.trim()
    : "Reunión sin título";
}

async function startRecording() {
  if (sessionId) return;
  await debugLoggingReady;
  sessionId = generateSessionId();
  setState("starting");

  meetingTitle = getCurrentMeetingTitle();
  debugLog("[Ariadne:debug] startRecording iniciado", { sessionId, meetingTitle });
  startedAt = Date.now();
  hasTranscript = false;
  videoEnabled = false;
  chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId, meetingTitle });

  let isFirstMuteReport = true;

  // observeMuteState informa el estado actual de forma síncrona en su primera
  // llamada — se aprovecha eso para mandar "start-session" recién ahí, con el
  // estado real de mute ya conocido (el GainNode del mic necesita arrancar en
  // el valor correcto desde el primer instante, ver Task 13 del plan).
  stopMuteObserver = observeMuteState((muted, timestampMs) => {
    micMuted = muted;
    updateBannerState(currentState, bannerMeta());
    if (isFirstMuteReport) {
      isFirstMuteReport = false;
      postToMainWorld({
        type: "asterion:start-session",
        sessionId,
        initialMicMuted: muted,
        debugLogging: isDebugEnabled(),
      });
      return;
    }
    postToMainWorld({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });

  const cleanup = await enableCaptionsAndObserve((snapshot) => {
    hasTranscript = true;
    updateBannerState(currentState, bannerMeta());
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

  debugLog("[Ariadne:debug] mensaje recibido desde MAIN world", { type: message.type });

  if (message.type === "asterion:session-started") {
    setState("recording");
  } else if (message.type === "asterion:start-failed") {
    sessionId = null;
    setState("error");
    cleanupObservers();
    console.error("[Ariadne] No se pudo iniciar la sesión:", message.reason);
  } else if (message.type === "asterion:chunk") {
    chrome.runtime.sendMessage({
      type: "asterion:chunk",
      sessionId: message.sessionId,
      stream: message.stream,
      seq: message.seq,
      bufferBase64: arrayBufferToBase64(message.buffer),
    });
  } else if (message.type === "asterion:speaker-label") {
    chrome.runtime.sendMessage({
      type: "asterion:speaker-label",
      sessionId: message.sessionId,
      label: message.label,
    });
  } else if (message.type === "asterion:video-enabled") {
    videoEnabled = true;
    setState("video-enabled");
  } else if (message.type === "asterion:video-enable-failed") {
    updateBannerState(currentState, bannerMeta({ videoError: message.message }));
  } else if (message.type === "asterion:session-ended") {
    chrome.runtime.sendMessage({
      type: "asterion:session-ended",
      sessionId: message.sessionId,
      muteManifest: message.muteManifest,
      endedAt: message.endedAt,
    });
    sessionId = null;
    meetingTitle = null;
    startedAt = null;
    hasTranscript = false;
    videoEnabled = false;
    setState("idle");
    cleanupObservers();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "asterion:get-status") {
    sendResponse({
      inMeeting: isInActiveMeeting(),
      state: currentState,
      meetingTitle: meetingTitle ?? getCurrentMeetingTitle(),
      startedAt,
      hasTranscript,
      micMuted,
      videoEnabled,
    });
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:session-finalized") {
    showFinishedBanner();
  }
});

window.addEventListener("pagehide", () => {
  if (sessionId) postToMainWorld({ type: "asterion:stop-session", sessionId });
});

function waitForMeeting() {
  debugLog("[Ariadne:debug] waitForMeeting isInActiveMeeting", { isInActiveMeeting: isInActiveMeeting() });

  const onMeetingDetected = () => {
    debugLog("[Ariadne:debug] reunión detectada");
    chrome.storage.local.get({ autoStart: true }, ({ autoStart }) => {
      debugLog("[Ariadne:debug] autoStart obtenido", { autoStart });
      showBanner({ onStart: startRecording, onStop: stopRecording });
      if (autoStart) startRecording();
    });
  };

  if (isInActiveMeeting()) {
    onMeetingDetected();
    return;
  }

  const observer = new MutationObserver(() => {
    if (isInActiveMeeting()) {
      observer.disconnect();
      onMeetingDetected();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

debugLoggingReady.then(waitForMeeting);
