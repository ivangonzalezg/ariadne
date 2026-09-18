// src/background/service-worker.js
const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const activeSessionTabIds = new Map();
const conversionStates = new Map();
let offscreenCreationPromise = null;

function updateBadge() {
  // Un texto que cambia constantemente (letra de fase + porcentaje) resulta
  // muy distractor sobre el ícono — solo mostramos cuántas reuniones se
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
    activeSessionTabIds.set(message.sessionId, sender.tab?.id ?? null);
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId: message.sessionId, meetingTitle: message.meetingTitle });
    });
  } else if (message.type === "asterion:session-finalized") {
    activeSessionTabIds.delete(message.sessionId);
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
      console.error("[Asterion] No se pudo leer el preset de video guardado, se usa 'medium' por defecto:", error);
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
