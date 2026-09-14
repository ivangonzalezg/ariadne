// src/background/service-worker.js
const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const activeSessionTabIds = new Map();
let offscreenCreationPromise = null;

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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "asterion:session-starting") {
    activeSessionTabIds.set(message.sessionId, sender.tab?.id ?? null);
    ensureOffscreenDocument();
  } else if (message.type === "asterion:session-finalized") {
    activeSessionTabIds.delete(message.sessionId);
    appendToHistory(message);
    if (activeSessionTabIds.size === 0) {
      chrome.offscreen.closeDocument().catch(() => {});
    }
  }
});

function appendToHistory(meta) {
  chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
    meetingHistory.unshift({
      sessionId: meta.sessionId,
      folderName: meta.folderName,
      startedAt: meta.startedAt,
      hasTranscript: meta.hasTranscript,
      hasVideo: meta.hasVideo,
    });
    chrome.storage.local.set({ meetingHistory: meetingHistory.slice(0, 200) });
  });
}
