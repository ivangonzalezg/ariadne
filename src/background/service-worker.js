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

export function registerActiveSession(sessionId, tabId, meetingTitle) {
  return withRegistryLock((activeSessions) => {
    activeSessions[sessionId] = { tabId, meetingTitle };
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

// El offscreen document se deja vivo entre reuniones a propósito: el permiso de
// File System Access sobre la carpeta raíz parece estar atado a la instancia del
// documento, no al origen de la extensión. Así, persiste hasta reiniciar el
// navegador o recargar la extensión.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "asterion:session-starting") {
    registerActiveSession(message.sessionId, sender.tab?.id ?? null, message.meetingTitle)
    .then(() => ensureOffscreenDocument())
    .then(() => {
      chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId: message.sessionId, meetingTitle: message.meetingTitle });
    });
  } else if (message.type === "asterion:session-finalized") {
    unregisterActiveSession(message.sessionId);
    appendToHistory(message);
  } else if (message.type === "asterion:conversion-started") {
    conversionStates.set(message.sessionId, {
      meetingTitle: message.meetingTitle,
      stream: message.stream,
      pct: 0,
    });
    updateBadge();
  } else if (message.type === "asterion:conversion-progress") {
    const state = conversionStates.get(message.sessionId);
    if (state) {
      conversionStates.set(message.sessionId, { ...state, stream: message.stream, pct: message.pct });
      updateBadge();
    }
  } else if (message.type === "asterion:conversion-finished") {
    conversionStates.delete(message.sessionId);
    updateBadge();
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
      console.error("[Ariadne] No se pudo leer el preset de video guardado, se usa 'medium' por defecto:", error);
      sendResponse({ videoPreset: "medium" });
    });

  return true;
});

function appendToHistory(meta) {
  chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
    meetingHistory.unshift({
      sessionId: meta.sessionId,
      folderName: meta.folderName,
      meetingTitle: meta.meetingTitle,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      durationMs: meta.durationMs,
      hasTranscript: meta.hasTranscript,
      hasVideo: meta.hasVideo,
    });
    chrome.storage.local.set({ meetingHistory: meetingHistory.slice(0, 200) });
  });
}

function finalizeAbandonedSession(sessionId) {
  // No se desregistra acá: si el envío del mensaje o la finalización fallan,
  // se pierde la única referencia durable para poder reintentar más adelante.
  // El registro se limpia como siempre, desde el handler de
  // "asterion:session-finalized" que ya corre cuando el offscreen document
  // termina de verdad (ver Tarea 1).
  return ensureOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      type: "asterion:session-ended",
      sessionId,
      muteManifest: null,
      endedAt: Date.now(),
    });
  });
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
