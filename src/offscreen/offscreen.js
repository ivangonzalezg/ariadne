// src/offscreen/offscreen.js
import { SessionWriter } from "../storage/session-writer.js";
import { base64ToArrayBuffer } from "../lib/base64.js";
import { setDebugEnabled } from "../shared/debug-log.js";

// chrome.storage puede venir undefined por un instante en algunos reloads en
// caliente de la extensión sin empaquetar (el documento offscreen viejo se
// destruye y uno nuevo se crea mientras el binding de la API todavía no está
// listo) - sin este guard, esa carrera tiraba una excepción no controlada acá
// que rompía todo el listener de mensajes de abajo, no solo el logging.
const debugLoggingReady = Promise.resolve()
  .then(() => chrome.storage.local.get({ debugLogging: false }))
  .then(({ debugLogging }) => setDebugEnabled(debugLogging))
  .catch((error) => {
    console.error("[Ariadne] No se pudo leer la configuración de debug logging (se deja apagado):", error);
  });

const sessions = new Map();
const finalizingSessionIds = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["asterion:session-starting", "asterion:chunk", "asterion:caption-snapshot", "asterion:speaker-label", "asterion:session-ended"].includes(message.type)) return;
  const handle = async () => {
  await debugLoggingReady;
  if (message.type === "asterion:session-starting") {
    if (sessions.has(message.sessionId)) return;
    const writer = new SessionWriter({ sessionId: message.sessionId, tabId: sender.tab?.id ?? null, meetingTitle: message.meetingTitle });
    sessions.set(message.sessionId, writer);
    await writer.ready;
  } else if (message.type === "asterion:chunk") {
    const writer = sessions.get(message.sessionId);
    if (!writer) {
      const error = new Error("Session storage unavailable"); error.retryable = true; throw error;
    }
    const committed = await writer.writeChunk(message.stream, base64ToArrayBuffer(message.bufferBase64), message);
    return { committed: true, ...committed };
  } else if (message.type === "asterion:caption-snapshot") {
    sessions.get(message.sessionId)?.onCaptionSnapshot(message.snapshot);
  } else if (message.type === "asterion:speaker-label") {
    sessions.get(message.sessionId)?.onSpeakerLabel(message.label);
  } else if (message.type === "asterion:session-ended") {
    const writer = sessions.get(message.sessionId);
    if (!writer || finalizingSessionIds.has(message.sessionId)) return;
    finalizingSessionIds.add(message.sessionId);
    writer.onConversionsFinished = () => {
      sessions.delete(message.sessionId);
      finalizingSessionIds.delete(message.sessionId);
    };
    writer
      .finalize({ muteManifest: message.muteManifest, endedAt: message.endedAt, persistenceErrors: message.persistenceErrors })
      .then((meta) => {
        chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...meta });
      })
      .catch((error) => {
        console.error("[Ariadne] Error finalizando la sesión:", error);
        sessions.delete(message.sessionId);
        finalizingSessionIds.delete(message.sessionId);
      });
  }
  };
  handle().then((result) => sendResponse?.(result ?? {})).catch((error) => {
    console.error("[Ariadne] Offscreen operation failed:", error);
    sendResponse?.({ error: error.message, retryable: error.retryable ?? false });
  });
  return true;
});
