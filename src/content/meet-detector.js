// src/content/meet-detector.js
import { findByIconText } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { showBanner, showFinishedBanner, updateBannerState } from "./meet-banner.js";
import { ChunkDelivery } from "./chunk-delivery.js";
import { debugLog, isDebugEnabled, setDebugEnabled } from "../shared/debug-log.js";

// Nunca debe rechazar: startRecording()/waitForMeeting() esperan esta promesa
// antes de arrancar, así que si chrome.storage.local.get fallara (ej. una
// carrera transitoria en un reload en caliente de la extensión) sin este
// catch, se rompería la grabación completa, no solo el logging de debug.
const debugLoggingReady = chrome.storage.local
  .get({ debugLogging: false })
  .then(({ debugLogging }) => {
    setDebugEnabled(debugLogging);
    debugLog("[Ariadne:debug] Content script (ISOLATED) loaded", { url: location.href });
  })
  .catch((error) => {
    console.error("[Ariadne] Could not read debug logging configuration; leaving it disabled:", error);
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

const deliveries = new Map();
let storageError = null;
let sessionId = null;
let currentState = "idle";
let meetingTitle = null;
let startedAt = null;
let hasTranscript = false;
let micMuted = true;
let videoEnabled = false;
let stopMuteObserver = () => {};
let stopCaptionObserver = () => {};
let stopMeetingEndObserver = () => {};
const MEETING_END_POLL_INTERVAL_MS = 3000;

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
  stopMeetingEndObserver();
  stopMuteObserver = () => {};
  stopCaptionObserver = () => {};
  stopMeetingEndObserver = () => {};
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
  debugLog("[Ariadne:debug] startRecording started", { sessionId, meetingTitle });
  startedAt = Date.now();
  hasTranscript = false;
  videoEnabled = false;
  try {
    const opened = await chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId, meetingTitle });
    if (!opened?.folderName || opened.error) throw new Error(opened?.error ?? "Storage initialization failed");
  } catch (error) {
    sessionId = null; setState("error"); cleanupObservers(); return;
  }
  storageError = null;
  const delivery = new ChunkDelivery({ sessionId,
    send: (message) => chrome.runtime.sendMessage(message),
    recover: async () => {
      const result = await chrome.runtime.sendMessage({ type: "asterion:recover-storage", sessionId: delivery.sessionId });
      if (result?.error) throw new Error(result.error);
    },
    onAck: (message) => postToMainWorld({ ...message, type: "asterion:chunk-committed" }),
    onStatus: (status) => postToMainWorld({ type: "asterion:storage-progress", ...status }),
    onFatal: (error) => {
      storageError = error.message; setState("error");
      postToMainWorld({ type: "asterion:stop-session", sessionId: delivery.sessionId, interruptionReason: error.message });
    },
  });
  deliveries.set(sessionId, delivery);
  delivery.statusTimer = setInterval(async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: "asterion:storage-status", sessionId: delivery.sessionId });
      if (!result?.error) postToMainWorld({ type: "asterion:storage-progress", ...result, pending: delivery.pending.size,
        pendingBytes: delivery.bytes, storageRecoveries: delivery.recoveries });
    } catch {}
  }, 5000);

  let isFirstMuteReport = true;

  // observeMuteState informa el estado actual de forma síncrona en su primera
  // llamada - se aprovecha eso para mandar "start-session" recién ahí, con el
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
    if (sessionId !== delivery.sessionId) return;
    hasTranscript = true;
    updateBannerState(currentState, bannerMeta());
    chrome.runtime.sendMessage({ type: "asterion:caption-snapshot", sessionId, snapshot });
  });
  if (sessionId !== delivery.sessionId) { cleanup?.(); return; }
  stopCaptionObserver = cleanup ?? (() => {});
  stopMeetingEndObserver = observeMeetingEnd();
}

function stopRecording() {
  if (!sessionId) return;
  postToMainWorld({ type: "asterion:stop-session", sessionId });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-main-world") return;

  debugLog("[Ariadne:debug] Message received from MAIN world", { type: message.type });

  if (message.type === "asterion:session-started") {
    setState("recording");
  } else if (message.type === "asterion:start-failed") {
    const delivery = deliveries.get(sessionId);
    clearInterval(delivery?.statusTimer);
    clearInterval(delivery?.watchdog);
    deliveries.delete(sessionId);
    if (sessionId) chrome.runtime.sendMessage({ type: "asterion:session-ended", sessionId, endedAt: Date.now(), interruptionReason: message.reason }).catch(() => {});
    sessionId = null;
    setState("error");
    cleanupObservers();
    console.error("[Ariadne] Could not start the session:", message.reason);
  } else if (message.type === "asterion:chunk") {
    deliveries.get(message.sessionId)?.add(message);
  } else if (message.type === "asterion:inspect-storage") {
    chrome.runtime.sendMessage({ type: "asterion:storage-status", sessionId: message.sessionId, folderName: message.folderName })
      .then((result) => {
        const delivery = deliveries.get(message.sessionId);
        postToMainWorld({ ...result, type: "asterion:storage-progress", sessionId: message.sessionId, requestId: message.requestId,
          pending: delivery?.pending.size ?? 0, pendingBytes: delivery?.bytes ?? 0,
          storageRecoveries: delivery?.recoveries ?? 0, available: Boolean(result && !result.error) });
      })
      .catch((error) => postToMainWorld({ type: "asterion:storage-progress", sessionId: message.sessionId, requestId: message.requestId, available: false, error: error.message }));
  } else if (message.type === "asterion:session-checkpoint") {
    Promise.resolve(deliveries.get(message.sessionId)?.drain()).then(() => chrome.runtime.sendMessage({ ...message, source: undefined })).catch(() => {});
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
    const delivery = deliveries.get(message.sessionId);
    (async () => {
      clearInterval(delivery?.statusTimer);
      const persistenceErrors = await delivery?.flush() ?? [];
      const result = await chrome.runtime.sendMessage({
        type: "asterion:session-ended", sessionId: message.sessionId, persistenceErrors,
        muteManifest: message.muteManifest, endedAt: message.endedAt, expectedSequences: message.expectedSequences,
        interruptionReason: message.interruptionReason ?? delivery?.fatal?.message ?? null,
      });
      if (!result?.error) {
        const status = await chrome.runtime.sendMessage({ type: "asterion:storage-status", sessionId: message.sessionId, folderName: result.folderName });
        if (!status?.error) postToMainWorld({ type: "asterion:storage-progress", ...status, pending: delivery?.pending.size ?? 0, storageRecoveries: delivery?.recoveries ?? 0 });
      }
      if (result?.error) { storageError = result.error; setState("error"); }
    })().catch((error) => { storageError = error.message; setState("error"); })
      .finally(() => deliveries.delete(message.sessionId));
    sessionId = null;
    meetingTitle = null;
    startedAt = null;
    hasTranscript = false;
    videoEnabled = false;
    setState(storageError ? "error" : "idle");
    cleanupObservers();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "asterion:get-status") {
    sendResponse({
      sessionId,
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
    if (message.recordingStatus === "incomplete" || storageError) setState("error");
    else showFinishedBanner();
  }
});

window.addEventListener("pagehide", () => {
  if (sessionId) postToMainWorld({ type: "asterion:stop-session", sessionId });
});

function observeMeetingEnd() {
  // Chequeo inicial inmediato: cubre el caso de que el usuario ya se haya
  // ido de la reunión mientras `startRecording()` todavía estaba esperando
  // `enableCaptionsAndObserve(...)`, antes de que este polling arrancara.
  if (!isInActiveMeeting()) {
    debugLog("[Ariadne:debug] Meeting ended (initial check); stopping recording automatically");
    stopRecording();
    return () => {};
  }

  const intervalId = setInterval(() => {
    if (!isInActiveMeeting()) {
      clearInterval(intervalId);
      debugLog("[Ariadne:debug] Meeting ended; stopping recording automatically");
      stopRecording();
    }
  }, MEETING_END_POLL_INTERVAL_MS);
  return () => clearInterval(intervalId);
}

function waitForMeeting() {
  debugLog("[Ariadne:debug] waitForMeeting isInActiveMeeting", { isInActiveMeeting: isInActiveMeeting() });

  const onMeetingDetected = () => {
    debugLog("[Ariadne:debug] Meeting detected");
    chrome.storage.local.get({ autoStart: true }, ({ autoStart }) => {
      debugLog("[Ariadne:debug] autoStart retrieved", { autoStart });
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
