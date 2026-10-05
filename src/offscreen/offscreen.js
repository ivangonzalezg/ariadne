import { recoverySettled } from "../storage/session-recovery.js";
import { SessionWriter } from "../storage/session-writer.js";
import { CAPTURE_STATE_FILE, readJson } from "../storage/capture-journal.js";
import { conversionQueue, processingQueue } from "./conversion-queue.js";
import { base64ToArrayBuffer } from "../lib/base64.js";
import { setDebugEnabled, debugEvent } from "../shared/debug-log.js";

const debugLoggingReady = Promise.resolve().then(() => chrome.storage.local.get({ debugLogging: false }))
  .then(({ debugLogging }) => setDebugEnabled(debugLogging)).catch(() => {});
const sessions = new Map();
const openings = new Map();
const finalizations = new Map();
const deletions = new Map();
let restoration = null;

async function openSession(message) {
  if (deletions.has(message.sessionId)) throw Object.assign(new Error("Session deleted"), { retryable: false });
  if (sessions.has(message.sessionId)) {
    const writer = sessions.get(message.sessionId);
    if (message.folderName && writer.folderName !== message.folderName) throw Object.assign(new Error("Session mismatch"), { retryable: false });
    return writer;
  }
  if (!message.folderName && message.type !== "asterion:session-starting") {
    throw Object.assign(new Error("Session storage unavailable"), { retryable: true });
  }
  if (!openings.has(message.sessionId)) {
    const operation = (async () => {
      const writer = message.folderName ? await SessionWriter.restore(message.folderName) : new SessionWriter(message);
      await writer.ready;
      if (writer.sessionId !== message.sessionId) throw Object.assign(new Error("Session mismatch"), { retryable: false });
      writer.onRecoveryFinished = () => sessions.delete(writer.sessionId);
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
    if (deletions.has(state.sessionId) || state.deleted) continue;
    try {
      if (!sessions.has(state.sessionId) && await recoverySettled(directory, state)) continue;
      const writer = await openSession({ ...state, folderName: directory.name });
      if (state.recordingStatus !== "recording") {
        if (state.recordingStatus === "finalizing") {
          await writer.finalize({ muteManifest: state.muteManifest, endedAt: state.endedAt,
            expectedSequences: state.expectedSequences, expectedCaptionEvents: state.expectedCaptionEvents,
            captionPersistenceErrors: state.captionPersistenceErrors, interruptionReason: state.interruptionReason });
        } else await writer.resumeRecovery();
      }
    } catch (error) {
      debugEvent("session-restore-error", { sessionId: state.sessionId, folderName: directory.name, message: error.message });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "asterion-offscreen" || !["asterion:recover-storage", "asterion:session-starting", "asterion:chunk", "asterion:caption-snapshot", "asterion:caption-event", "asterion:speaker-label", "asterion:session-checkpoint", "asterion:storage-status", "asterion:session-ended", "asterion:get-recovery-status", "asterion:retry-recovery", "asterion:delete-session"].includes(message.type)) return;
  const handle = async () => {
    await debugLoggingReady;
    if (message.type === "asterion:recover-storage") {
      restoration ??= restorePending().finally(() => { restoration = null; });
      await restoration; conversionQueue.wake(); processingQueue.wake();
      const recordings = [...sessions.values()].filter((writer) => writer.journal.state.recordingStatus === "recording")
        .map((writer) => ({ sessionId: writer.sessionId, tabId: writer.tabId, meetingTitle: writer.meetingTitle, folderName: writer.folderName }));
      const unpublished = [...sessions.values()].filter(writer => writer.recordingStatus !== "recording" && !writer.journal.state.historyPublished)
        .map(writer => writer.getMetadata());
      return { pending: conversionQueue.snapshot().length > 0 || processingQueue.snapshot().length > 0 || recordings.length > 0, recordings, unpublished };
    }
    if (message.type === "asterion:delete-session" && deletions.has(message.sessionId)) return deletions.get(message.sessionId);
    if (message.type === "asterion:delete-session" && !sessions.has(message.sessionId)) {
      const root = await navigator.storage.getDirectory();
      let directory;
      try { directory = await root.getDirectoryHandle(message.folderName); }
      catch (error) { if (error.name === "NotFoundError") return { ok: true }; throw error; }
      let state;
      try { state = await readJson(directory, CAPTURE_STATE_FILE); } catch {}
      if (!state) {
        // The worker has validated this legacy folder against meetingHistory.
        const manifest = await readJson(directory, "manifest.json").catch(() => null);
        if (manifest?.sessionId && manifest.sessionId !== message.sessionId) throw Object.assign(new Error("Session mismatch"), { retryable: false });
        await root.removeEntry(message.folderName, { recursive: true });
        return { ok: true };
      }
    }
    const writer = await openSession(message);
    if (message.type === "asterion:get-recovery-status") return { ...writer.getMetadata(), recovery: writer.recovery.snapshot() };
    if (message.type === "asterion:retry-recovery") {
      await writer.resumeRecovery({ retry: true });
      return { ...writer.getMetadata(), recovery: writer.recovery.snapshot() };
    }
    if (message.type === "asterion:delete-session") {
      if (writer.recordingStatus === "recording") throw Object.assign(new Error("Session still recording"), { retryable: false });
      const operation = (async () => {
        writer.cancelled = true;
        writer.recovery.initialController?.abort();
        await Promise.allSettled([writer.recovery.initialExport, finalizations.get(writer.sessionId)].filter(Boolean));
        await writer.recoveryOperation;
        await Promise.all([conversionQueue.cancelSession(writer.sessionId), processingQueue.cancelSession(writer.sessionId)]);
        await writer.recovery.queue;
        await writer.journal.queue;
        await writer.journal.checkpoint({ deleted: true });
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(writer.folderName, { recursive: true });
        sessions.delete(writer.sessionId); finalizations.delete(writer.sessionId);
        return { ok: true };
      })();
      deletions.set(writer.sessionId, operation);
      operation.catch(() => deletions.delete(writer.sessionId));
      return operation;
    }
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
      return snapshot;
    }
    else if (message.type === "asterion:session-ended") {
      if (!finalizations.has(message.sessionId)) {
        const operation = writer.finalize(message);
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
      ...(message.type === "asterion:get-recovery-status" ? { recovery: { supported: false, pending: false, canRetry: false, tasks: [] } } : {}),
      ...(message.type === "asterion:session-ended" && writer ? { sessionId: writer.sessionId,
        folderName: writer.folderName, startedAt: writer.startedAt, endedAt: message.endedAt ?? Date.now(),
        durationMs: (message.endedAt ?? Date.now()) - writer.startedAt, meetingTitle: writer.meetingTitle,
        hasTranscript: writer.transcriptExported ?? writer.hasCaption, transcriptStatus: writer.transcriptStatus, hasVideo: writer.streamsUsed.has("video"), recordingStatus: "incomplete", interruptionReason: message.interruptionReason ?? error.message } : {}) });
  });
  return true;
});
