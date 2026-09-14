// src/offscreen/offscreen.js
import { SessionWriter } from "../storage/session-writer.js";

const sessions = new Map();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "asterion:session-starting") {
    if (sessions.has(message.sessionId)) return;
    const writer = new SessionWriter({ sessionId: message.sessionId, tabId: sender.tab?.id ?? null });
    sessions.set(message.sessionId, writer);
    writer.ready.catch((error) => {
      console.error("[Asterion] No se pudo iniciar el storage de la sesión:", error);
    });
  } else if (message.type === "asterion:chunk") {
    const writer = sessions.get(message.sessionId);
    writer?.writeChunk(message.stream, message.buffer).catch((error) => {
      console.error("[Asterion] Error escribiendo chunk:", error);
    });
  } else if (message.type === "asterion:caption-snapshot") {
    sessions.get(message.sessionId)?.onCaptionSnapshot(message.snapshot);
  } else if (message.type === "asterion:session-ended") {
    const writer = sessions.get(message.sessionId);
    if (!writer) return;
    writer
      .finalize({ muteManifest: message.muteManifest })
      .then((meta) => {
        chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...meta });
      })
      .catch((error) => {
        console.error("[Asterion] Error finalizando la sesión:", error);
      })
      .finally(() => {
        sessions.delete(message.sessionId);
      });
  }
});
