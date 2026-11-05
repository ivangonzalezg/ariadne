import { MEETING_CLEANUP_VERSION } from "./meeting-cleanup-state.js";
import { BlobReader, TextReader, TextWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { CAPTURE_FORMAT_VERSION, CAPTURE_STATE_FILE, readJson, writeFile } from "./capture-journal.js";
import { LIBRARY_LOCK, PENDING_IMPORT, rollbackPendingImport } from "./library-lock.js";

const INDEX = "ariadne-backup.json";
const FORMAT = "ariadne-meeting-backup";
const VERSION = 2;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const ZIP_OPTIONS = { useWebWorkers: false };
const ROOT_FILES = new Set([
  CAPTURE_STATE_FILE, "manifest.json", "audio-reunion.webm", "audio-reunion.mp3",
  "video-reunion.webm", "video-reunion.mp4", "transcripcion.json",
  "transcripcion.txt", "transcripcion.md",
]);

const error = code => Object.assign(new Error(code), { code });
const validId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value) &&
  !Object.hasOwn(Object.prototype, value);
const validFolder = value => typeof value === "string" && value.length > 0 && !/[\\/\u0000-\u001f:]/.test(value) &&
  value !== "." && value !== "..";
const forbiddenArchiveCharacters = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const reservedArchiveName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const archiveFolderIdentity = name => name.normalize("NFC").toUpperCase();

function validArchiveFolder(name) {
  return validFolder(name) && !forbiddenArchiveCharacters.test(name) &&
    name === name.trim() && !name.endsWith(".") && !reservedArchiveName.test(name) &&
    new TextEncoder().encode(name).byteLength <= 255;
}

function archiveFolderName(title, usedNames) {
  const safeTitle = title.normalize("NFC").replace(new RegExp(forbiddenArchiveCharacters.source, "g"), "-");
  // Leave room for a duplicate suffix even when the title uses four-byte characters.
  let base = [...safeTitle.trim()].slice(0, 60).join("").replace(/[.\s]+$/u, "");
  if (!base) base = "Meeting";
  if (reservedArchiveName.test(base)) base = "_" + base;
  let name = base;
  for (let suffix = 2; usedNames.has(archiveFolderIdentity(name)); suffix++) name = `${base} (${suffix})`;
  return name;
}

const validSize = value => Number.isSafeInteger(value) && value >= 0;
const supportedPath = path => !/[\u0000-\u001f\\]/.test(path) && (ROOT_FILES.has(path) || /^(?:meeting|video)-segment-\d+\.webm$/.test(path) ||
  /^capture-records\/(?:meeting|video)-\d+-\d+\.chunk$/.test(path) || /^caption-records\/\d+\.json$/.test(path));

function limitedJson(path) {
  return path === CAPTURE_STATE_FILE || path === "manifest.json" || path.startsWith("caption-records/");
}

async function optionalJson(directory, name) {
  try {
    const value = await readJson(directory, name);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw error("libraryInvalid");
    return value;
  } catch (cause) {
    if (cause.name === "NotFoundError") return null;
    throw cause;
  }
}

async function listFiles(directory, signal) {
  const files = new Map();
  for await (const handle of directory.values()) {
    signal?.throwIfAborted();
    if (handle.kind === "file" && supportedPath(handle.name)) files.set(handle.name, await handle.getFile());
    if (handle.kind === "directory" && ["capture-records", "caption-records"].includes(handle.name)) {
      for await (const record of handle.values()) {
        signal?.throwIfAborted();
        const path = `${handle.name}/${record.name}`;
        if (record.kind === "file" && supportedPath(path)) files.set(path, await record.getFile());
      }
    }
  }
  return files;
}

function validateMetadata(meta, id) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta) ||
      meta.sessionId !== id || !validFolder(meta.folderName) ||
      !Number.isFinite(meta.startedAt) || (meta.endedAt != null && !Number.isFinite(meta.endedAt)) ||
      (meta.meetingTitle != null && typeof meta.meetingTitle !== "string") ||
      !["complete", "incomplete"].includes(meta.recordingStatus) ||
      (meta.processing?.tasks != null && (!Array.isArray(meta.processing.tasks) ||
        meta.processing.tasks.some(task => !task || typeof task !== "object")))) {
    throw error("invalid");
  }
}

async function library(root, { collectFiles = false, signal } = {}) {
  const { meetingHistory, pendingSessionDeletions } = await chrome.storage.local.get({
    meetingHistory: [], pendingSessionDeletions: {},
  });
  const byFolder = new Map(meetingHistory.map(entry => [entry.folderName, entry]));
  const deletedFolders = new Set(Object.values(pendingSessionDeletions));
  const existingIds = new Set(meetingHistory.map(entry => entry.sessionId));
  const meetings = [];
  const seen = new Set(), exportedFolders = new Set(), skippedFolders = new Set();
  for await (const directory of root.values()) {
    signal?.throwIfAborted();
    if (directory.kind !== "directory" || deletedFolders.has(directory.name)) continue;
    try {
      const state = await optionalJson(directory, CAPTURE_STATE_FILE).catch(cause => {
        if (collectFiles || cause.name === "AbortError") throw cause;
        return null;
      });
      if (state?.deleted || state?.recordingStatus === "discarded") {
        deletedFolders.add(directory.name);
        continue;
      }
      if (state?.sessionId) existingIds.add(state.sessionId);
      const indexed = byFolder.get(directory.name);
      if (!collectFiles && state?.sessionId) continue;
      const manifest = await optionalJson(directory, "manifest.json");
      const id = state?.sessionId ?? manifest?.sessionId ?? indexed?.sessionId;
      if (id) existingIds.add(id);
      if (!collectFiles) continue;
      const files = await listFiles(directory, signal);
      if (!indexed && !state && !manifest && !files.size) continue;
      if (!validId(id) || seen.has(id) || (indexed && indexed.sessionId !== id) ||
          (manifest?.sessionId != null && manifest.sessionId !== id) ||
          (manifest?.folderName != null && manifest.folderName !== directory.name) ||
          (state && (state.folderName !== directory.name || state.version !== CAPTURE_FORMAT_VERSION))) {
        throw error("libraryInvalid");
      }
      if (["recording", "finalizing"].includes(state?.recordingStatus)) throw error("processing");
      const meta = {
        ...manifest, ...indexed,
        sessionId: id, folderName: directory.name,
        startedAt: state?.startedAt ?? indexed?.startedAt ?? manifest?.startedAt,
        endedAt: state?.endedAt ?? indexed?.endedAt ?? manifest?.endedAt ?? null,
        meetingTitle: indexed?.meetingTitle ?? state?.meetingTitle ?? manifest?.meetingTitle ?? null,
        platform: state?.platform ?? indexed?.platform ?? manifest?.platform ?? null,
        recordingStatus: state?.recordingStatus ?? indexed?.recordingStatus ?? manifest?.recordingStatus ?? "complete",
        hasTranscript: files.has("transcripcion.json"),
        hasAudioMp3: files.has("audio-reunion.mp3"),
        hasVideoMp4: files.has("video-reunion.mp4"),
        hasVideo: Boolean(indexed?.hasVideo || manifest?.hasVideo || files.has("video-reunion.webm") || files.has("video-reunion.mp4") ||
          [...files.keys()].some(path => path.startsWith("capture-records/video-"))),
      };
      delete meta.diskSize;
      delete meta.cleanup;
      meta.durationMs = Math.max(0, (meta.endedAt ?? meta.startedAt) - meta.startedAt);
      validateMetadata(meta, id);
      if (state) validateCaptureState(state, { sessionId: id, meta });
      if (!files.size) throw error("libraryInvalid");
      for (const [path, file] of files) {
        if (limitedJson(path) && file.size > MAX_JSON_BYTES) throw error("tooLarge");
      }
      seen.add(id);
      meetings.push({ meta, files });
      exportedFolders.add(directory.name);
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause.name === "AbortError" || cause.code === "processing") throw cause;
      if (collectFiles) skippedFolders.add(directory.name);
    }
  }
  if (collectFiles) {
    for (const { folderName } of meetingHistory) {
      if (!exportedFolders.has(folderName) && !deletedFolders.has(folderName)) skippedFolders.add(folderName);
    }
  }
  return { meetings, meetingHistory, existingIds, skipped: skippedFolders.size };
}

export async function getBackupStatus() {
  const status = await chrome.runtime.sendMessage({ type: "asterion:backup-status" });
  return status?.reason === null ? null : status?.reason ?? "unavailable";
}

export function withBackupLibrary(operation, signal) {
  return navigator.locks.request(LIBRARY_LOCK, { ifAvailable: true }, async lock => {
    if (!lock) throw error("busy");
    signal?.throwIfAborted();
    const reason = await getBackupStatus();
    if (reason) throw error(reason);
    await rollbackPendingImport();
    signal?.throwIfAborted();
    return operation();
  });
}

function byteProgress(total, report) {
  let completed = 0;
  return {
    options: { onprogress: bytes => report?.(completed + bytes, total) },
    finish: bytes => { completed += bytes; report?.(completed, total); },
  };
}

export async function exportMeetingBackup(root, writable, { signal, onProgress } = {}) {
  const librarySnapshot = await library(root, { collectFiles: true, signal });
  const { meetings } = librarySnapshot;
  let skipped = librarySnapshot.skipped;
  if (!meetings.length) throw error(skipped ? "libraryInvalid" : "empty");
  const index = { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), meetings: [] };
  const total = meetings.reduce((sum, meeting) => sum + [...meeting.files.values()]
    .reduce((bytes, file) => bytes + file.size, 0), 0);
  const progress = byteProgress(total, onProgress);
  const destination = writable.getWriter();
  let outputFailed = false, bytesWritten = 0;
  const stream = new WritableStream({
    async write(chunk) {
      try {
        await destination.write(chunk);
        bytesWritten += chunk.byteLength;
      } catch (cause) {
        outputFailed = true;
        throw cause;
      }
    },
  });
  try {
    const zip = new ZipWriter(stream, { ...ZIP_OPTIONS, level: 0, zip64: true, preventClose: true });
    const usedNames = new Set();
    for (const { meta, files } of meetings) {
      const key = archiveFolderName(meta.meetingTitle || meta.folderName, usedNames);
      const meetingOffset = bytesWritten;
      const saved = [];
      let remainingBytes = [...files.values()].reduce((sum, file) => sum + file.size, 0);
      try {
        for (const [path, file] of files) {
          signal?.throwIfAborted();
          const name = `meetings/${key}/${path}`;
          await zip.add(name, new BlobReader(file), { ...progress.options, signal });
          saved.push({ path, size: file.size });
          remainingBytes -= file.size;
          progress.finish(file.size);
        }
        index.meetings.push({ key, sessionId: meta.sessionId, meta, files: saved });
        usedNames.add(archiveFolderIdentity(key));
      } catch (cause) {
        signal?.throwIfAborted();
        if (outputFailed || cause.name === "AbortError") throw cause;
        // A meeting is restorable only when every listed file made it into the ZIP.
        for (const { path } of saved) zip.remove(`meetings/${key}/${path}`);
        if (bytesWritten > meetingOffset) {
          // Erase unindexed payloads while preserving the offsets held by ZipWriter.
          await destination.write({ type: "truncate", size: meetingOffset });
          await destination.write({ type: "truncate", size: bytesWritten });
          await destination.write({ type: "seek", position: bytesWritten });
        }
        skipped++;
        progress.finish(remainingBytes);
      }
    }
    if (!index.meetings.length) throw error("libraryInvalid");
    const indexText = JSON.stringify(index, null, 2);
    if (new TextEncoder().encode(indexText).byteLength > MAX_JSON_BYTES) throw error("tooLarge");
    await zip.add(INDEX, new TextReader(indexText), { signal });
    await zip.close();
    signal?.throwIfAborted();
    await destination.close();
    return { count: index.meetings.length, skipped };
  } finally {
    destination.releaseLock();
  }
}

async function readBackup(file, signal) {
  const zip = new ZipReader(new BlobReader(file), { ...ZIP_OPTIONS, strictness: "strict", checkCrc32: true });
  try {
    const entries = new Map();
    for await (const entry of zip.getEntriesGenerator({ signal })) {
      signal?.throwIfAborted();
      if (entry.directory || entry.encrypted || entry.compressionMethod !== 0 || entries.has(entry.filename) ||
          !validSize(entry.uncompressedSize) || entry.compressedSize !== entry.uncompressedSize) throw error("invalid");
      entries.set(entry.filename, entry);
    }
    const indexEntry = entries.get(INDEX);
    if (!indexEntry || indexEntry.uncompressedSize > MAX_JSON_BYTES) throw error("invalid");
    const index = JSON.parse(await indexEntry.getData(new TextWriter(), { signal }));
    if (index?.format !== FORMAT) throw error("invalid");
    if (![1, VERSION].includes(index.version)) throw error("version");
    if (!Array.isArray(index.meetings) || !index.meetings.length || !Number.isFinite(Date.parse(index.createdAt))) {
      throw error("invalid");
    }
    const ids = new Set(), folders = new Set(), paths = new Set([INDEX]);
    for (const [position, meeting] of index.meetings.entries()) {
      const id = meeting?.sessionId;
      const key = meeting?.key;
      const validKey = index.version === 1 ? key === String(position + 1) : validArchiveFolder(key);
      if (!validId(id) || ids.has(id) || !validKey || folders.has(archiveFolderIdentity(key)) ||
          !Array.isArray(meeting.files) || !meeting.files.length) throw error("invalid");
      ids.add(id);
      folders.add(archiveFolderIdentity(key));
      validateMetadata(meeting.meta, id);
      for (const item of meeting.files) {
        if (typeof item?.path !== "string" || !supportedPath(item.path) || !validSize(item.size)) throw error("invalid");
        const path = `meetings/${meeting.key}/${item.path}`;
        if (paths.has(path) || entries.get(path)?.uncompressedSize !== item.size ||
            (limitedJson(item.path) && item.size > MAX_JSON_BYTES)) throw error("invalid");
        paths.add(path);
      }
    }
    if (paths.size !== entries.size) throw error("invalid");
    return { zip, entries, meetings: index.meetings };
  } catch (cause) {
    await zip.close();
    if (cause.code || cause.name === "AbortError") throw cause;
    throw error("invalid");
  }
}

export async function previewMeetingBackup(root, file, signal) {
  const { zip, meetings } = await readBackup(file, signal);
  try {
    const { existingIds } = await library(root, { signal });
    const skipped = meetings.filter(meeting => existingIds.has(meeting.sessionId)).length;
    return { added: meetings.length - skipped, skipped };
  } finally { await zip.close(); }
}

function validateCaptureState(state, meeting) {
  if (state?.version !== CAPTURE_FORMAT_VERSION || state.sessionId !== meeting.sessionId ||
      state.folderName !== meeting.meta.folderName || state.deleted ||
      !["complete", "incomplete"].includes(state.recordingStatus) || state.startedAt !== meeting.meta.startedAt) {
    throw error("invalid");
  }
  if (state.cleanup != null && (state.cleanup.version !== MEETING_CLEANUP_VERSION ||
      !["pending", "complete"].includes(state.cleanup.status))) throw error("invalid");
  for (const key of ["conversions", "recoveryTasks", "captionSnapshots", "speakerLabels", "persistenceErrors", "captureSegments"]) {
    if (state[key] != null && (!Array.isArray(state[key]) || state[key].some(item => !item || typeof item !== "object"))) {
      throw error("invalid");
    }
  }
  for (const seq of Object.values(state.expectedSequences ?? {})) {
    if (!validSize(seq) || seq > 10_000_000) throw error("invalid");
  }
}

async function extractFile(entry, path, destination, meeting, folderName, options) {
  if (path === CAPTURE_STATE_FILE || path === "manifest.json") {
    const data = JSON.parse(await entry.getData(new TextWriter(), options));
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        (data.sessionId != null && data.sessionId !== meeting.sessionId) ||
        (data.folderName != null && data.folderName !== meeting.meta.folderName)) throw error("invalid");
    if (path === CAPTURE_STATE_FILE) {
      validateCaptureState(data, meeting);
      data.tabId = null;
    }
    if (Object.hasOwn(data, "folderName")) data.folderName = folderName;
    if (destination) await writeFile(destination, path, JSON.stringify(data), options.signal);
    return;
  }
  if (!destination) {
    // Validate even skipped meetings without writing their payloads.
    await entry.getData(new WritableStream(), options);
    return;
  }
  const [subfolder, name] = path.split("/");
  const directory = name ? await destination.getDirectoryHandle(subfolder, { create: true }) : destination;
  const handle = await directory.getFileHandle(name ?? subfolder, { create: true });
  const writable = await handle.createWritable();
  try { await entry.getData(writable, options); }
  catch (cause) { await writable.abort().catch(() => {}); throw cause; }
}

export async function importMeetingBackup(root, file, { signal, onProgress } = {}) {
  const { zip, entries, meetings } = await readBackup(file, signal);
  let pending = false;
  try {
    const { meetingHistory, existingIds } = await library(root, { signal });
    const folders = new Map(meetings.filter(meeting => !existingIds.has(meeting.sessionId))
      .map(meeting => [meeting.sessionId, `restore-${crypto.randomUUID()}`]));
    // The rollback journal must only contain names that this operation owns.
    for (const name of folders.values()) {
      try { await root.getDirectoryHandle(name); throw error("busy"); }
      catch (cause) { if (cause.name !== "NotFoundError") throw cause; }
    }
    if (folders.size) {
      await chrome.storage.local.set({ [PENDING_IMPORT]: { folders: [...folders.values()] } });
      pending = true;
    }
    const total = meetings.reduce((sum, meeting) => sum + meeting.files.reduce((bytes, item) => bytes + item.size, 0), 0);
    const progress = byteProgress(total, onProgress);
    const added = [];
    for (const meeting of meetings) {
      signal?.throwIfAborted();
      const folderName = folders.get(meeting.sessionId);
      const directory = folderName ? await root.getDirectoryHandle(folderName, { create: true }) : null;
      for (const { path, size } of meeting.files) {
        signal?.throwIfAborted();
        const entry = entries.get(`meetings/${meeting.key}/${path}`);
        await extractFile(entry, path, directory, meeting, folderName, { ...progress.options, signal });
        progress.finish(size);
      }
      if (directory) {
        const { diskSize, cleanup, ...metadata } = meeting.meta;
        added.push({ ...metadata, folderName });
      }
    }
    signal?.throwIfAborted();
    if (added.length) {
      const merged = [...meetingHistory, ...added].sort((a, b) => b.startedAt - a.startedAt);
      await chrome.storage.local.set({ meetingHistory: merged, [PENDING_IMPORT]: null });
      pending = false;
    }
    return { added: added.length, skipped: meetings.length - added.length };
  } finally {
    try { if (pending) await rollbackPendingImport(); }
    finally { await zip.close(); }
  }
}
