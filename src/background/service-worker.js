// src/background/service-worker.js
const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const ACTIVE_SESSIONS_KEY = "activeRecordingSessions";

// Serializa las lecturas/escrituras del registro para que dos llamadas
// concurrentes (ej. dos reuniones arrancando casi al mismo tiempo) no se
// pisen: sin esto, dos "get -> mutar -> set" en paralelo podrían leer el
// mismo estado viejo y la segunda escritura descartaría lo que agregó la
// primera.
let registryQueue = Promise.resolve();

function withRegistryLock(mutator) {
  const result = registryQueue.then(async () => {
    const { [ACTIVE_SESSIONS_KEY]: activeSessions } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
    mutator(activeSessions);
    await chrome.storage.local.set({ [ACTIVE_SESSIONS_KEY]: activeSessions });
  });
  registryQueue = result.catch(() => {});
  return result;
}

export function registerActiveSession(sessionId, tabId, meetingTitle, folderName) {
  return withRegistryLock((activeSessions) => {
    activeSessions[sessionId] = { ...activeSessions[sessionId], tabId, meetingTitle, ...(folderName ? { folderName } : {}) };
  });
}

export function unregisterActiveSession(sessionId) {
  return withRegistryLock((activeSessions) => {
    delete activeSessions[sessionId];
  });
}

export async function findActiveSessionIdsForTab(tabId) {
  const { [ACTIVE_SESSIONS_KEY]: activeSessions } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
  return Object.entries(activeSessions)
    .filter(([, session]) => session.tabId === tabId)
    .map(([sessionId]) => sessionId);
}

const conversionStates = new Map();
let offscreenCreationPromise = null;

function updateBadge() {
  // Un texto que cambia constantemente (letra de fase + porcentaje) resulta
  // muy distractor sobre el ícono - solo mostramos cuántas reuniones se
  // están procesando en simultáneo, que cambia poco.
  const text = conversionStates.size > 0 ? String(conversionStates.size) : "";

  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color: "#3B82F6" });
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;

  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["BLOBS"],
        justification: "Escribir localmente el audio, video y transcripción de una reunión de Meet.",
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }
  await offscreenCreationPromise;
}

const STORAGE_TYPES = new Set(["asterion:session-starting", "asterion:chunk", "asterion:caption-snapshot", "asterion:speaker-label", "asterion:session-checkpoint", "asterion:storage-status", "asterion:session-ended", "asterion:recover-storage"]);
const RECOVERY_ALARM = "asterion-storage-recovery";
let conversionPending = false;
let storageRecovery = null;
let historyQueue = Promise.resolve();

async function updateRecoveryAlarm() {
  const { [ACTIVE_SESSIONS_KEY]: active } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
  if (Object.keys(active).length || conversionPending) {
    if (!await chrome.alarms?.get(RECOVERY_ALARM)) await chrome.alarms?.create(RECOVERY_ALARM, { periodInMinutes: 1 });
  } else await chrome.alarms?.clear(RECOVERY_ALARM);
}

async function forwardStorage(message, tabId) {
  if (message.type === "asterion:recover-storage" && message.sessionId) {
    storageRecovery ??= (async () => {
      const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (existing.length) await chrome.offscreen.closeDocument();
      await ensureOffscreenDocument();
    })().finally(() => { storageRecovery = null; });
    await storageRecovery;
  } else {
    if (storageRecovery) await storageRecovery;
    await ensureOffscreenDocument();
  }
  const { [ACTIVE_SESSIONS_KEY]: active } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
  const registration = active[message.sessionId];
  const result = await chrome.runtime.sendMessage({ ...message, target: "asterion-offscreen", tabId: tabId ?? registration?.tabId,
    folderName: message.folderName ?? registration?.folderName });
  if (!result) throw new Error("Storage transport unavailable");
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "asterion-offscreen") return;
  if (STORAGE_TYPES.has(message.type)) {
    (async () => {
      if (message.type === "asterion:session-starting") await registerActiveSession(message.sessionId, sender.tab?.id ?? null, message.meetingTitle);
      if (message.type === "asterion:session-ended") await withRegistryLock((active) => {
        if (active[message.sessionId]) active[message.sessionId].finalization = message;
      });
      const result = await forwardStorage(message, sender.tab?.id);
      if (message.type === "asterion:session-ended" && result.error && result.retryable === false && result.folderName) {
        await withRegistryLock((active) => {
          if (active[message.sessionId]) active[message.sessionId].finalization = { ...message, interruptionReason: result.interruptionReason };
        });
        await appendToHistory(result);
      }
      if (message.type === "asterion:session-starting" && !result.error) await registerActiveSession(message.sessionId, sender.tab?.id ?? null, message.meetingTitle, result.folderName);
      if (message.type === "asterion:recover-storage") conversionPending = result.pending;
      await updateRecoveryAlarm();
      return result;
    })().then(sendResponse).catch((error) => sendResponse({ error: error.message, retryable: true }));
    return true;
  }
  if (message.type === "asterion:session-finalized") {
    appendToHistory(message).then(() => unregisterActiveSession(message.sessionId)).then(updateRecoveryAlarm)
      .then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message, retryable: true }));
    return true;
  } else if (message.type === "asterion:recovery-pending") {
    conversionPending = message.pending; updateRecoveryAlarm().catch(console.error);
  } else if (message.type === "asterion:conversion-started") {
    conversionStates.set(message.sessionId, { meetingTitle: message.meetingTitle, stream: message.stream, pct: 0 }); updateBadge();
  } else if (message.type === "asterion:conversion-progress") {
    const state = conversionStates.get(message.sessionId);
    if (state) conversionStates.set(message.sessionId, { ...state, stream: message.stream, pct: message.pct });
    updateBadge();
  } else if (message.type === "asterion:conversion-finished") {
    conversionStates.delete(message.sessionId); updateBadge();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "asterion:get-conversion-status") {
    sendResponse({ count: conversionStates.size, entries: [...conversionStates.values()] });
    return;
  }

  if (message.type !== "asterion:get-video-preset") return;

  chrome.storage.local
    .get({ videoPreset: "medium" })
    .then(({ videoPreset }) => sendResponse({ videoPreset }))
    .catch((error) => {
      console.error("[Ariadne] Could not read the saved video preset; using 'medium':", error);
      sendResponse({ videoPreset: "medium" });
    });

  return true;
});

function appendToHistory(meta) {
  const operation = historyQueue.then(async () => {
    const { meetingHistory } = await chrome.storage.local.get({ meetingHistory: [] });
    const entries = meetingHistory.filter((entry) => entry.sessionId !== meta.sessionId);
    const { sessionId, folderName, meetingTitle, startedAt, endedAt, durationMs, hasTranscript, hasVideo, recordingStatus, interruptionReason } = meta;
    entries.push({ sessionId, folderName, meetingTitle, startedAt, endedAt, durationMs, hasTranscript, hasVideo, recordingStatus, interruptionReason });
    entries.sort((a, b) => b.startedAt - a.startedAt);
    await chrome.storage.local.set({ meetingHistory: entries.slice(0, 200) });
  });
  historyQueue = operation.catch(() => {});
  return operation;
}

async function finalizeAbandonedSession(sessionId) {
  const { [ACTIVE_SESSIONS_KEY]: active } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
  const requested = active[sessionId]?.finalization;
  return forwardStorage(requested ?? { type: "asterion:session-ended", sessionId, muteManifest: null,
    endedAt: Date.now(), interruptionReason: "capture-tab-disappeared" });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessionIds = await findActiveSessionIdsForTab(tabId);
  for (const sessionId of sessionIds) {
    await finalizeAbandonedSession(sessionId);
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const sessionIds = await findActiveSessionIdsForTab(details.tabId);
  for (const sessionId of sessionIds) {
    await finalizeAbandonedSession(sessionId);
  }
});

async function recoverPendingSessions() {
  const result = await forwardStorage({ type: "asterion:recover-storage" });
  conversionPending = result.pending;
  for (const recording of result.recordings ?? []) {
    await registerActiveSession(recording.sessionId, recording.tabId, recording.meetingTitle, recording.folderName);
  }
  const { [ACTIVE_SESSIONS_KEY]: active } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
  for (const [sessionId, entry] of Object.entries(active)) {
    let status;
    try { status = await chrome.tabs.sendMessage(entry.tabId, { type: "asterion:get-status" }); } catch {}
    if (status?.sessionId !== sessionId) await finalizeAbandonedSession(sessionId);
  }
  await updateRecoveryAlarm();
}
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === RECOVERY_ALARM) recoverPendingSessions().catch(console.error);
});
chrome.runtime.onStartup?.addListener(() => recoverPendingSessions().catch(console.error));
// Recreate recovery after service-worker eviction as well as browser startup.
if (chrome.alarms) recoverPendingSessions().catch(console.error);
