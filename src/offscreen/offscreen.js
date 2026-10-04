import { SessionWriter } from "../storage/session-writer.js";
import { CAPTURE_STATE_FILE, readJson } from "../storage/capture-journal.js";
import { conversionQueue } from "./conversion-queue.js";
import { base64ToArrayBuffer } from "../lib/base64.js";
import { setDebugEnabled, debugEvent } from "../shared/debug-log.js";

const debugLoggingReady = Promise.resolve().then(() => chrome.storage.local.get({ debugLogging: false }))
  .then(({ debugLogging }) => setDebugEnabled(debugLogging)).catch(() => {});
const sessions = new Map();
const openings = new Map();
const finalizations = new Map();
let restoration = null;

async function openSession(message) {
  if (sessions.has(message.sessionId)) return sessions.get(message.sessionId);
  if (!message.folderName && message.type !== "asterion:session-starting") {
    throw Object.assign(new Error("Session storage unavailable"), { retryable: true });
  }
  if (!openings.has(message.sessionId)) {
    const operation = (async () => {
      const writer = message.folderName ? await SessionWriter.restore(message.folderName) : new SessionWriter(message);
      await writer.ready;
      if (writer.sessionId !== message.sessionId) throw Object.assign(new Error("Session mismatch"), { retryable: false });
      sessions.set(message.sessionId, writer);
      return writer;
    })().finally(() => openings.delete(message.sessionId));
    openings.set(message.sessionId, operation);
  }
  return openings.get(message.sessionId);
}

async function restorePending() {
  const root = await navigator.storage.getDirectory();
  for await (const directory of root.values()) {
    if (directory.kind !== "directory") continue;
    let state;
    try { state = await readJson(directory, CAPTURE_STATE_FILE); } catch { continue; }
    if (state.recordingStatus !== "recording" && state.conversions?.length && state.conversions.every((job) => ["succeeded", "failed"].includes(job.state) && job.published) && state.historyPublished) continue;
    try {
      const writer = await openSession({ ...state, folderName: directory.name });
      if (state.recordingStatus !== "recording") {
        writer.recordingStatus = state.recordingStatus; writer.interruptionReason = state.interruptionReason;
        writer.onConversionsFinished = () => sessions.delete(writer.sessionId);
        let meta;
        if (state.recordingStatus === "finalizing" || !state.conversions?.length) {
          meta = await writer.finalize({ muteManifest: state.muteManifest, endedAt: state.endedAt,
            expectedSequences: state.expectedSequences, expectedCaptionEvents: state.expectedCaptionEvents, captionPersistenceErrors: state.captionPersistenceErrors, interruptionReason: state.interruptionReason });
        } else {
          if (state.recordingStatus === "complete") await writer.scheduleConversions(state.muteManifest, state.endedAt);
          meta = { sessionId: writer.sessionId, tabId: state.tabId, folderName: directory.name,
            startedAt: state.startedAt, endedAt: state.endedAt, durationMs: state.endedAt - state.startedAt,
            meetingTitle: state.meetingTitle, hasTranscript: writer.transcriptExported ?? writer.hasCaption, transcriptStatus: writer.transcriptStatus, hasVideo: writer.hasVideo,
            recordingStatus: state.recordingStatus, interruptionReason: state.interruptionReason };
        }
        const published = await chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...meta });
        if (published?.ok) await writer.checkpoint({ historyPublished: true }).catch((error) => debugEvent("history-checkpoint-error", { message: error.message }));
      }
    } catch (error) {
      debugEvent("session-restore-error", { sessionId: state.sessionId, folderName: directory.name, message: error.message });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "asterion-offscreen" || !["asterion:recover-storage", "asterion:session-starting", "asterion:chunk", "asterion:caption-snapshot", "asterion:caption-event", "asterion:speaker-label", "asterion:session-checkpoint", "asterion:storage-status", "asterion:session-ended"].includes(message.type)) return;
  const handle = async () => {
    await debugLoggingReady;
    if (message.type === "asterion:recover-storage") {
      restoration ??= restorePending().finally(() => { restoration = null; });
      await restoration; conversionQueue.wake();
      const recordings = [...sessions.values()].filter((writer) => writer.journal.state.recordingStatus === "recording")
        .map((writer) => ({ sessionId: writer.sessionId, tabId: writer.tabId, meetingTitle: writer.meetingTitle, folderName: writer.folderName }));
      return { pending: conversionQueue.snapshot().length > 0 || recordings.length > 0, recordings };
    }
    const writer = await openSession(message);
    if (message.type === "asterion:session-starting") return { folderName: writer.folderName, ...writer.getStorageSnapshot() };
    if (message.type === "asterion:chunk") {
      const ack = await writer.writeChunk(message.stream, base64ToArrayBuffer(message.bufferBase64), message);
      return { committed: true, ...ack };
    }
    if (message.type === "asterion:caption-event") return { committed: true, ...await writer.onCaptionEvent(message.event) };
    if (message.type === "asterion:caption-snapshot") await writer.onCaptionSnapshot(message.snapshot);
    else if (message.type === "asterion:speaker-label") await writer.onSpeakerLabel(message.label);
    else if (message.type === "asterion:session-checkpoint") {
      const update = { muteManifest: message.muteManifest };
      if (message.expectedCaptionEvents != null) update.expectedCaptionEvents = Math.max(writer.journal.state.expectedCaptionEvents ?? 0, message.expectedCaptionEvents);
      if (message.expectedSequences) update.expectedSequences = Object.fromEntries(["meeting", "video"].map((stream) => [stream,
        Math.max(writer.journal.state.expectedSequences?.[stream] ?? 0, message.expectedSequences[stream] ?? 0)]));
      for (const key of Object.keys(update)) if (update[key] === undefined) delete update[key];
      if (message.generation !== undefined) update.generations = [...new Set([...writer.journal.state.generations, message.generation])];
      await writer.checkpoint(update);
      if (message.generationClosed) {
        await writer.checkpoint({ closedGenerations: { ...writer.journal.state.closedGenerations,
          [message.generation]: { expectedSequences: message.expectedSequences, closedAt: Date.now() } } });
        await Promise.all(writer.writeQueueByStream.values());
        for (const stream of writer.streamsUsed) await writer.journal.materialize(stream, { prefix: true });
      }
    } else if (message.type === "asterion:storage-status") {
      const snapshot = writer.getStorageSnapshot();
      if (["complete", "incomplete"].includes(snapshot.recordingStatus) && snapshot.conversions.every((job) => ["succeeded", "failed"].includes(job.state))) sessions.delete(message.sessionId);
      return snapshot;
    }
    else if (message.type === "asterion:session-ended") {
      writer.onConversionsFinished = () => sessions.delete(message.sessionId);
      if (!finalizations.has(message.sessionId)) {
        const operation = writer.finalize(message).then(async (meta) => {
          const published = await chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...meta });
          if (published?.ok) await writer.checkpoint({ historyPublished: true }).catch((error) => debugEvent("history-checkpoint-error", { message: error.message }));
          return meta;
        });
        finalizations.set(message.sessionId, operation);
        operation.catch(() => finalizations.delete(message.sessionId));
      }
      return finalizations.get(message.sessionId);
    }
    return {};
  };
  handle().then(sendResponse).catch((error) => {
    const definitive = error.retryable === false || error.name === "QuotaExceededError" || /Invalid|mismatch|Conflicting|finalized/.test(error.message);
    debugEvent("storage-operation-error", { sessionId: message.sessionId, code: error.code ?? error.name, message: error.message });
    const writer = sessions.get(message.sessionId);
    sendResponse({ error: error.message, retryable: !definitive, code: error.code ?? error.name,
      ...(message.type === "asterion:session-ended" && writer ? { sessionId: writer.sessionId,
        folderName: writer.folderName, startedAt: writer.startedAt, endedAt: message.endedAt ?? Date.now(),
        durationMs: (message.endedAt ?? Date.now()) - writer.startedAt, meetingTitle: writer.meetingTitle,
        hasTranscript: writer.transcriptExported ?? writer.hasCaption, transcriptStatus: writer.transcriptStatus, hasVideo: writer.streamsUsed.has("video"), recordingStatus: "incomplete", interruptionReason: message.interruptionReason ?? error.message } : {}) });
  });
  return true;
});
