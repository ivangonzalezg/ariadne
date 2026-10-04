import { CaptionDelivery } from "./caption-delivery.js";
import { CaptionRouter } from "./caption-router.js";
// src/content/meet-detector.js
import { findByIconText } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { showBanner, showFinishedBanner, updateBannerState } from "./meet-banner.js";
import { ChunkDelivery } from "./chunk-delivery.js";
import { debugEvent, debugLog, isDebugEnabled, setDebugEnabled } from "../shared/debug-log.js";

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
// Stored text and capture readiness are separate, including during silence.
let hasTranscript = false;
let transcriptActive = false;
let captionState = "preparing";
let captionStorage = { pending: 0, error: null };
let captionMode = "dom";
let micMuted = true;
let videoEnabled = false;
let stopMuteObserver = () => {};
let stopCaptionObserver = () => {};
let stopMeetingEndObserver = () => {};
const MEETING_END_POLL_INTERVAL_MS = 3000;

function bannerMeta(extra = {}) {
  return { meetingTitle, startedAt, hasTranscript, transcriptActive, captionState, captionStorage, micMuted, videoEnabled, ...extra };
}

function setState(state, meta = {}) {
  currentState = state;
  updateBannerState(state, bannerMeta(meta));
}

function cleanupObservers() {
  transcriptActive = false;
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
  transcriptActive = false;
  captionState = "preparing"; captionStorage = { pending: 0, error: null };
  const preferences = await chrome.storage.local.get({ captionMode: "dom" }).catch(() => ({ captionMode: "dom" }));
  captionMode = ["dom", "shadow", "hybrid"].includes(preferences.captionMode) ? preferences.captionMode : "dom";
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
  delivery.captions = new CaptionDelivery({ sessionId,
    send: (message) => chrome.runtime.sendMessage(message),
    recover: delivery.recover,
    onAck: () => {
      if (sessionId !== delivery.sessionId) return;
      hasTranscript = true; updateBannerState(currentState, bannerMeta());
    },
    onStatus: (status) => {
      debugEvent("caption-storage", { sessionId: delivery.sessionId, ...status });
      if (sessionId !== delivery.sessionId) return;
      captionStorage = status; updateBannerState(currentState, bannerMeta());
      postToMainWorld({ type: "asterion:caption-storage", sessionId: delivery.sessionId, ...status });
    },
  });
  delivery.router = new CaptionRouter({ sessionId, mode: captionMode,
    emit: (event) => delivery.captions.add(event), log: debugEvent });
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
        captionMode,
        debugLogging: isDebugEnabled(),
      });
      return;
    }
    postToMainWorld({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });

  const cleanup = enableCaptionsAndObserve((snapshot) => {
    if (sessionId !== delivery.sessionId || delivery.captionCutoff != null) return;
    delivery.router.receive(snapshot);
  }, {
    onStatus: (status) => {
      if (sessionId !== delivery.sessionId) return;
      const previous = delivery.domStatus;
      delivery.domStatus = status; captionState = status.state;
      if (captionMode === "hybrid" && status.state === "active" && !delivery.router.rtcUsable && !status.panel && delivery.rtcStatus) captionState = "recovering";
      transcriptActive = status.state === "active";
      if (previous?.state !== status.state) {
        debugEvent("caption-capture-state", { sessionId, ...status });
        postToMainWorld({ type: "asterion:caption-enabled", sessionId, enabled: status.state === "active" });
      }
      updateBannerState(currentState, bannerMeta());
    },
  });
  delivery.stopDom = cleanup;
  if (sessionId !== delivery.sessionId) { cleanup?.(); return; }
  stopCaptionObserver = cleanup ?? (() => {});
  stopMeetingEndObserver = observeMeetingEnd();
}

function stopRecording() {
  if (!sessionId) return;
  const delivery = deliveries.get(sessionId);
  const endedAt = Date.now();
  cutoffCaptions(delivery, endedAt);
  postToMainWorld({ type: "asterion:stop-session", sessionId, endedAt });
}

function cutoffCaptions(delivery, endedAt) {
  if (!delivery || delivery.captionCutoff != null) return;
  delivery.stopDom?.flush?.();
  delivery.stopDom?.();
  delivery.captionCutoff = endedAt;
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-main-world") return;

  debugLog("[Ariadne:debug] Message received from MAIN world", { type: message.type });

  if (message.type === "asterion:rtc-caption") {
    const delivery = deliveries.get(message.sessionId);
    if (!delivery || message.sessionId !== sessionId ||
        (delivery.captionCutoff != null && message.event.updatedAt > delivery.captionCutoff)) return;
    delivery.router.receive(message.event);
  } else if (message.type === "asterion:caption-health") {
    const delivery = deliveries.get(message.sessionId);
    if (!delivery || message.sessionId !== sessionId) return;
    delivery.router.setRtcStatus(message);
    delivery.rtcStatus = message;
    debugEvent("caption-channel-health", message);
    if (captionMode === "hybrid" && delivery.captionCutoff == null && delivery.domStatus?.state === "active") {
      captionState = message.usable ? "active" : delivery.domStatus.panel ? "active" : "recovering";
      updateBannerState(currentState, bannerMeta());
    }
  } else if (message.type === "asterion:caption-cutoff") {
    cutoffCaptions(deliveries.get(message.sessionId), message.endedAt);
  } else if (message.type === "asterion:session-started") {
    if (message.sessionId !== sessionId) return;
    postToMainWorld({ type: "asterion:caption-enabled", sessionId, enabled: deliveries.get(sessionId)?.domStatus?.state === "active" });
    setState("recording");
  } else if (message.type === "asterion:start-failed") {
    const delivery = deliveries.get(sessionId);
    clearInterval(delivery?.statusTimer);
    clearInterval(delivery?.watchdog);
    delivery?.captions.dispose();
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
    Promise.resolve(deliveries.get(message.sessionId)?.drain()).then(() => chrome.runtime.sendMessage({ ...message, source: undefined, expectedCaptionEvents: deliveries.get(message.sessionId)?.captions.eventSeq })).catch(() => {});
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
    if (message.sessionId !== sessionId) return;
    const delivery = deliveries.get(message.sessionId);
    cutoffCaptions(delivery, message.endedAt);
    (async () => {
      clearInterval(delivery?.statusTimer);
      const [persistenceErrors, captionPersistenceErrors] = await Promise.all([delivery?.flush() ?? [], delivery?.captions.flush() ?? []]);
      const result = await chrome.runtime.sendMessage({
        type: "asterion:session-ended", sessionId: message.sessionId, persistenceErrors,
        captionPersistenceErrors, expectedCaptionEvents: delivery?.captions.eventSeq ?? 0,
        muteManifest: message.muteManifest, endedAt: message.endedAt, expectedSequences: message.expectedSequences,
        interruptionReason: message.interruptionReason ?? delivery?.fatal?.message ?? null,
      });
      if (!result?.error) {
        const status = await chrome.runtime.sendMessage({ type: "asterion:storage-status", sessionId: message.sessionId, folderName: result.folderName });
        if (!status?.error) postToMainWorld({ type: "asterion:storage-progress", ...status, pending: delivery?.pending.size ?? 0, storageRecoveries: delivery?.recoveries ?? 0 });
      }
      if (result?.error && (!sessionId || sessionId === message.sessionId)) { storageError = result.error; setState("error"); }
    })().catch((error) => { if (!sessionId || sessionId === message.sessionId) { storageError = error.message; setState("error"); } })
      .finally(() => { if (!delivery?.captions.pending.size) deliveries.delete(message.sessionId); });
    sessionId = null;
    meetingTitle = null;
    startedAt = null;
    hasTranscript = false;
    transcriptActive = false;
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
      transcriptActive,
      captionState, captionStorage, captionMode,
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
    if (sessionId) return;
    if (message.recordingStatus === "incomplete" || storageError) setState("error");
    else showFinishedBanner();
  }
});

window.addEventListener("pagehide", () => {
  if (sessionId) stopRecording();
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
