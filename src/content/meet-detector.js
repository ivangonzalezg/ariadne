import { getMeetingPlatform } from "./meeting-platform.js";
import { CaptionDelivery } from "./caption-delivery.js";
import { CaptionRouter } from "./caption-router.js";
// src/content/meet-detector.js
import { observeMeetingPresence } from "./meeting-presence.js";
import { showBanner, updateBannerState } from "./meet-banner.js";
import { ChunkDelivery } from "./chunk-delivery.js";
import { debugEvent, debugLog, isDebugEnabled, setDebugEnabled } from "../shared/debug-log.js";

const platform = getMeetingPlatform();
const isInActiveMeeting = () => platform.isInActiveMeeting();
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

function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function postToMainWorld(message) {
  window.postMessage({ source: "asterion-isolated-world", ...message }, "*");
}

const deliveries = new Map();
const drainingSessionIds = new Set();
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
let meetingActive = false;
let meetingGeneration = 0;
let autoStartGeneration = null;
let lastCaptureGeneration = null;
let captureAttempt = null;
let notice = null;

function refreshBanner(extra = {}) {
  updateBannerState(notice?.state ?? currentState, bannerMeta({
    visible: Boolean(notice) || meetingActive,
    captureSessionId: notice?.sessionId ?? null,
    ...extra,
  }));
}

function dismissNotice(expectedSessionId = notice?.sessionId) {
  if (!notice || notice.sessionId !== expectedSessionId) return;
  notice = null;
  refreshBanner();
}

function beginNotice(reason, endedAt = Date.now()) {
  if (!sessionId || notice?.sessionId === sessionId) return;
  // Use the writer's session snapshot, not a fresh preference read or the UI timer.
  // Its minimum-duration decision must agree with finalization at the boundary.
  if (captureAttempt?.minimumMeetingDurationSeconds > 0 &&
      Math.max(0, endedAt - captureAttempt.storageStartedAt) < captureAttempt.minimumMeetingDurationSeconds * 1000) return;
  notice = { sessionId, reason, state: "saving", revision: -1 };
  refreshBanner();
}

function updateNotice(metadata) {
  if (!notice || notice.sessionId !== metadata.sessionId) return;
  if (metadata.discarded) { dismissNotice(); return; }
  const revision = metadata.processing?.revision ?? 0;
  if (!metadata.error && (revision < notice.revision ||
      (revision === notice.revision && notice.state === "finished" && metadata.processing?.pending))) return;
  notice.revision = Math.max(notice.revision, revision);
  const failed = metadata.error || metadata.recordingStatus === "incomplete" ||
    metadata.transcriptStatus === "incomplete" || metadata.processing?.canRetry ||
    [metadata.audioConversionStatus, metadata.videoConversionStatus, metadata.transcriptExportStatus].includes("failed");
  notice.state = failed ? "capture-error" : metadata.processing?.pending ||
    [metadata.audioConversionStatus, metadata.videoConversionStatus, metadata.transcriptExportStatus].includes("pending")
    ? "processing" : "finished";
  refreshBanner();
}

function maybeAutoStart() {
  if (autoStartGeneration !== meetingGeneration || !meetingActive || sessionId) return;
  autoStartGeneration = null;
  void startRecording();
}

function bannerMeta(extra = {}) {
  return { meetingTitle, startedAt, hasTranscript, transcriptActive, captionState, captionStorage, micMuted, videoEnabled, ...extra };
}

function setState(state, meta = {}) {
  currentState = state;
  refreshBanner(meta);
}

function cleanupObservers() {
  transcriptActive = false;
  stopMuteObserver();
  stopCaptionObserver();
  stopMuteObserver = () => {};
  stopCaptionObserver = () => {};
}

function getCurrentMeetingTitle() {
  return platform.getTitle();
}

async function startRecording() {
  if (!isInActiveMeeting()) return { ok: false, error: "Meeting is not active" };
  if (sessionId) return { ok: false, error: "Capture is already active" };
  const attempt = { id: generateSessionId(), generation: meetingGeneration, stopped: false, mainStarted: false };
  captureAttempt = attempt;
  lastCaptureGeneration = meetingGeneration;
  sessionId = attempt.id; // Reserve before awaiting, including popup/banner races.
  notice = null;
  autoStartGeneration = null;
  setState("starting");
  await debugLoggingReady;
  if (!canContinueStart(attempt)) return cancelStart(attempt);

  meetingTitle = getCurrentMeetingTitle();
  debugLog("[Ariadne:debug] startRecording started", { sessionId, meetingTitle });
  startedAt = Date.now();
  hasTranscript = false;
  transcriptActive = false;
  captionState = "preparing"; captionStorage = { pending: 0, error: null };
  const preferences = await chrome.storage.local.get({ captionMode: "dom" }).catch(() => ({ captionMode: "dom" }));
  if (!canContinueStart(attempt)) return cancelStart(attempt);
  captionMode = platform.captionMode(preferences.captionMode);
  videoEnabled = false;
  try {
    const opened = await chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId, meetingTitle, platform: platform.id });
    if (!opened?.folderName || opened.error) throw new Error(opened?.error ?? "Storage initialization failed");
    attempt.opened = true;
    attempt.storageStartedAt = opened.startedAt;
    attempt.minimumMeetingDurationSeconds = opened.minimumMeetingDurationSeconds ?? 0;
    if (!canContinueStart(attempt)) return cancelStart(attempt);
  } catch (error) {
    if (captureAttempt === attempt) {
      updateNotice({ sessionId: attempt.id, error: error.message });
      sessionId = null; captureAttempt = null; setState("error"); cleanupObservers(); maybeAutoStart();
    }
    return { ok: false, error: error.message };
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
      if (sessionId !== delivery.sessionId) return;
      storageError = error.message;
      stopRecording(isInActiveMeeting() ? "manual" : "meeting-left", error.message);
      updateNotice({ sessionId: delivery.sessionId, error: error.message });
    },
  });
  delivery.captions = new CaptionDelivery({ sessionId,
    send: (message) => chrome.runtime.sendMessage(message),
    recover: delivery.recover,
    onAck: (event) => {
      if (event.kind === "local-identity") return;
      if (sessionId !== delivery.sessionId) return;
      hasTranscript = true; refreshBanner();
    },
    onStatus: (status) => {
      debugEvent("caption-storage", { sessionId: delivery.sessionId, ...status });
      if (sessionId !== delivery.sessionId) return;
      captionStorage = status; refreshBanner();
      postToMainWorld({ type: "asterion:caption-storage", sessionId: delivery.sessionId, ...status });
    },
  });
  delivery.router = new CaptionRouter({ sessionId, mode: captionMode,
    emit: (event) => delivery.captions.add(event), log: debugEvent });
  deliveries.set(sessionId, delivery);
  delivery.stopIdentity = platform.observeLocalIdentity(identity => {
    if (sessionId !== delivery.sessionId || delivery.captionCutoff != null) return;
    delivery.router.setLocalIdentity(identity);
    debugEvent("caption-local-identity", { sessionId, ...identity });
  });
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
  stopMuteObserver = platform.observeMuteState((muted, timestampMs) => {
    micMuted = muted;
    refreshBanner();
    if (isFirstMuteReport) {
      isFirstMuteReport = false;
      attempt.mainStarted = true;
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

  const cleanup = platform.observeCaptions((snapshot) => {
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
      refreshBanner();
    },
  });
  delivery.stopDom = cleanup;
  if (sessionId !== delivery.sessionId) { cleanup?.(); delivery.stopIdentity?.(); return; }
  stopCaptionObserver = () => { cleanup?.(); delivery.stopIdentity?.(); };
  if (!attempt.mainStarted) return cancelStart(attempt);
  return { ok: true };
}

function canContinueStart(attempt) {
  return captureAttempt === attempt && !attempt.stopped &&
    attempt.generation === meetingGeneration && isInActiveMeeting();
}

async function cancelStart(attempt) {
  if (notice?.sessionId === attempt.id) dismissNotice();
  if (attempt.opened) {
    try {
      const result = await chrome.runtime.sendMessage({ type: "asterion:session-ended", sessionId: attempt.id,
        endedAt: attempt.endedAt ?? Date.now(), interruptionReason: "capture-start-cancelled" });
      updateNotice({ ...result, sessionId: attempt.id });
    } catch (error) { updateNotice({ sessionId: attempt.id, error: error.message }); }
  }
  if (captureAttempt === attempt) {
    const delivery = deliveries.get(attempt.id);
    clearInterval(delivery?.statusTimer);
    delivery?.captions.dispose();
    deliveries.delete(attempt.id);
    sessionId = null; captureAttempt = null; cleanupObservers(); setState("idle"); maybeAutoStart();
  }
  return { ok: false, error: "Capture start cancelled" };
}

function stopRecording(reason = "manual", interruptionReason = null) {
  if (!sessionId || captureAttempt?.stopped) return;
  const endedAt = Date.now();
  if (captureAttempt) Object.assign(captureAttempt, { stopped: true, endedAt });
  beginNotice(reason, endedAt);
  setState("stopping");
  const delivery = deliveries.get(sessionId);
  cutoffCaptions(delivery, endedAt);
  if (captureAttempt?.mainStarted) postToMainWorld({ type: "asterion:stop-session", sessionId, endedAt, interruptionReason });
}

function cutoffCaptions(delivery, endedAt) {
  if (!delivery || delivery.captionCutoff != null) return;
  delivery.stopIdentity?.flush?.();
  delivery.stopIdentity?.();
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
      refreshBanner();
    }
  } else if (message.type === "asterion:caption-cutoff") {
    cutoffCaptions(deliveries.get(message.sessionId), message.endedAt);
  } else if (message.type === "asterion:session-started") {
    if (message.sessionId !== sessionId || captureAttempt?.stopped) return;
    postToMainWorld({ type: "asterion:caption-enabled", sessionId, enabled: deliveries.get(sessionId)?.domStatus?.state === "active" });
    setState("recording");
  } else if (message.type === "asterion:start-failed") {
    if (message.sessionId && message.sessionId !== sessionId) return;
    const delivery = deliveries.get(sessionId);
    clearInterval(delivery?.statusTimer);
    clearInterval(delivery?.watchdog);
    delivery?.captions.dispose();
    deliveries.delete(sessionId);
    if (sessionId) chrome.runtime.sendMessage({ type: "asterion:session-ended", sessionId, endedAt: Date.now(), interruptionReason: message.reason }).catch(() => {});
    updateNotice({ sessionId, error: message.reason });
    sessionId = null;
    captureAttempt = null;
    setState("error");
    cleanupObservers();
    maybeAutoStart();
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
    if (captureAttempt?.stopped || (message.sessionId && message.sessionId !== sessionId)) return;
    videoEnabled = true;
    setState("video-enabled");
  } else if (message.type === "asterion:video-enable-failed") {
    refreshBanner({ videoError: message.message });
  } else if (message.type === "asterion:session-ended") {
    if (message.sessionId !== sessionId) return;
    const delivery = deliveries.get(message.sessionId);
    if (message.interruptionReason === "capture-start-cancelled" && notice?.sessionId === message.sessionId) dismissNotice();
    // Recorder failures may end a capture without an explicit stop click.
    if (!captureAttempt?.stopped) beginNotice(isInActiveMeeting() ? "manual" : "meeting-left", message.endedAt);
    cutoffCaptions(delivery, message.endedAt);
    // Recovery must keep this writer open while deliveries drain, even if a
    // new capture starts before this session finishes saving.
    drainingSessionIds.add(message.sessionId);
    (async () => {
      clearInterval(delivery?.statusTimer);
      const [persistenceErrors, captionPersistenceErrors] = await Promise.all([delivery?.flush() ?? [], delivery?.captions.flush() ?? []]);
      const result = await chrome.runtime.sendMessage({
        type: "asterion:session-ended", sessionId: message.sessionId, persistenceErrors,
        captionPersistenceErrors, expectedCaptionEvents: delivery?.captions.eventSeq ?? 0,
        muteManifest: message.muteManifest, endedAt: message.endedAt, expectedSequences: message.expectedSequences,
        interruptionReason: message.interruptionReason ?? delivery?.fatal?.message ?? null,
      });
      updateNotice({ ...(result ?? { error: "Storage transport unavailable" }), sessionId: message.sessionId });
      if (result && !result.error && !result.discarded) {
        const status = await chrome.runtime.sendMessage({ type: "asterion:storage-status", sessionId: message.sessionId, folderName: result.folderName });
        if (!status?.error) postToMainWorld({ type: "asterion:storage-progress", ...status, pending: delivery?.pending.size ?? 0, storageRecoveries: delivery?.recoveries ?? 0 });
      }
    })().catch((error) => updateNotice({ sessionId: message.sessionId, error: error.message }))
      .finally(() => {
        drainingSessionIds.delete(message.sessionId);
        if (!delivery?.captions.pending.size) {
          delivery?.captions.dispose();
          deliveries.delete(message.sessionId);
        }
      });
    sessionId = null;
    captureAttempt = null;
    meetingTitle = null;
    startedAt = null;
    hasTranscript = false;
    transcriptActive = false;
    videoEnabled = false;
    setState(storageError ? "error" : "idle");
    cleanupObservers();
    maybeAutoStart();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "asterion:get-status") {
    sendResponse({
      sessionId,
      drainingSessionIds: [...drainingSessionIds],
      platform: platform.id,
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
    startRecording().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "asterion:popup-stop") {
    stopRecording();
    sendResponse({ ok: true });
    return true;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:session-finalized") updateNotice(message);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !notice || !changes.meetingHistory) return;
  const entry = changes.meetingHistory.newValue?.find(entry => entry.sessionId === notice.sessionId);
  if (entry) updateNotice(entry);
});

window.addEventListener("pagehide", () => {
  if (sessionId) stopRecording("meeting-left");
});

async function onMeetingPresence(active) {
  meetingActive = active;
  const generation = ++meetingGeneration;
  autoStartGeneration = null;
  if (!active) {
    if (notice?.reason === "manual") notice = null;
    if (sessionId && !captureAttempt?.stopped) stopRecording("meeting-left");
    refreshBanner();
    return;
  }
  notice = null;
  if (!sessionId) currentState = "idle";
  if (!sessionId || captureAttempt?.stopped) storageError = null;
  await showBanner({ onStart: () => void startRecording(), onStop: () => stopRecording(), onDismiss: dismissNotice });
  refreshBanner();
  const { autoStart } = await chrome.storage.local.get({ autoStart: true }).catch(() => ({ autoStart: false }));
  if (generation !== meetingGeneration || !isInActiveMeeting()) return;
  if (autoStart && lastCaptureGeneration !== generation) {
    autoStartGeneration = generation;
    maybeAutoStart();
  }
}

debugLoggingReady.then(() => observeMeetingPresence(active => { void onMeetingPresence(active); }, { isActive: isInActiveMeeting }));
