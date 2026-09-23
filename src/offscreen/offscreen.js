// src/offscreen/offscreen.js
import { SessionWriter } from "../storage/session-writer.js";
import { base64ToArrayBuffer } from "../lib/base64.js";
import { setDebugEnabled } from "../shared/debug-log.js";

const debugLoggingReady = chrome.storage.local.get({ debugLogging: false }).then(({ debugLogging }) => setDebugEnabled(debugLogging));

const sessions = new Map();

chrome.runtime.onMessage.addListener(async (message, sender) => {
  await debugLoggingReady;
  if (message.type === "asterion:session-starting") {
    if (sessions.has(message.sessionId)) return;
    const writer = new SessionWriter({ sessionId: message.sessionId, tabId: sender.tab?.id ?? null, meetingTitle: message.meetingTitle });
    sessions.set(message.sessionId, writer);
    writer.ready.catch((error) => {
      console.error("[Ariadne] No se pudo iniciar el storage de la sesión:", error);
    });
  } else if (message.type === "asterion:chunk") {
    const writer = sessions.get(message.sessionId);
    writer?.writeChunk(message.stream, base64ToArrayBuffer(message.bufferBase64)).catch((error) => {
      console.error("[Ariadne] Error escribiendo chunk:", error);
    });
  } else if (message.type === "asterion:caption-snapshot") {
    sessions.get(message.sessionId)?.onCaptionSnapshot(message.snapshot);
  } else if (message.type === "asterion:speaker-label") {
    sessions.get(message.sessionId)?.onSpeakerLabel(message.label);
  } else if (message.type === "asterion:session-ended") {
    const writer = sessions.get(message.sessionId);
    if (!writer) return;
    writer.onConversionsFinished = () => sessions.delete(message.sessionId);
    writer
      .finalize({ muteManifest: message.muteManifest, endedAt: message.endedAt })
      .then((meta) => {
        chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...meta });
      })
      .catch((error) => {
        console.error("[Ariadne] Error finalizando la sesión:", error);
        sessions.delete(message.sessionId);
      });
  }
});
