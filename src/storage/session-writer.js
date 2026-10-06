// src/storage/session-writer.js
import { CaptionJournal } from "./caption-journal.js";
import { CaptionParser } from "../lib/caption-parser.js";
import { reconcileCaptionSnapshots } from "../lib/speaker-label-reconciler.js";
import { runFfmpegAttempt } from "../offscreen/ffmpeg-client.js";
import { CaptureJournal, CAPTURE_FORMAT_VERSION, readJson, CAPTURE_STATE_FILE, writeFile } from "./capture-journal.js";
import { SessionRecovery, hasFile } from "./session-recovery.js";
import { conversionQueue } from "../offscreen/conversion-queue.js";

const STREAM_FILE_NAMES = {
  meeting: "audio-reunion.webm",
  video: "video-reunion.webm",
};

function sanitizeForFolderName(text) {
  return text.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80).trim() || "Reunión";
}

function meetingFolderName(startedAt, meetingTitle, sessionId) {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `${sanitizeForFolderName(meetingTitle)} - ${iso} - ${sanitizeForFolderName(sessionId)}`;
}

function sendConversionMessage(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // La señal de progreso no debe interrumpir la conversión real.
  }
}

export class SessionWriter {
  constructor({ sessionId, tabId, meetingTitle, folderName = null, restore = false }) {
    this.sessionId = sessionId;
    this.tabId = tabId;
    this.meetingTitle = meetingTitle || "Reunión sin título";
    this.startedAt = Date.now();
    this.folderName = folderName;
    this.restoring = restore;
    this.writeFailures = new Map();
    this.writeQueueByStream = new Map();
    this.segments = new Map();
    this.lastSequence = new Map();
    this.committedChunks = 0;
    this.captionParser = new CaptionParser();
    this.captionSnapshots = [];
    this.speakerLabels = [];
    this.hasCaption = false;
    this.streamsUsed = new Set();
    this.captionQueue = Promise.resolve();
    this._finalizePromise = null;
    this.ready = this._init();
  }

  async _init() {
    const root = await navigator.storage.getDirectory();
    this.folderName ??= meetingFolderName(this.startedAt, this.meetingTitle, this.sessionId);
    this.meetingHandle = await root.getDirectoryHandle(this.folderName, { create: !this.restoring });
    this.journal = await CaptureJournal.open(this.meetingHandle, this.restoring ? null : {
      version: CAPTURE_FORMAT_VERSION, sessionId: this.sessionId, tabId: this.tabId, folderName: this.folderName,
      meetingTitle: this.meetingTitle, startedAt: this.startedAt, recordingStatus: "recording",
      generations: [], expectedSequences: {}, conversions: [], captionSnapshots: [], speakerLabels: [], muteManifest: null,
    });
    if (this.journal.state.sessionId !== this.sessionId) throw new Error("Session state mismatch");
    const state = this.journal.state;
    this.startedAt = state.startedAt; this.endedAt = state.endedAt; this.meetingTitle = state.meetingTitle;
    this.captionSnapshots = state.captionSnapshots ?? []; this.speakerLabels = state.speakerLabels ?? [];
    this.captions = await CaptionJournal.open(this.meetingHandle, this.sessionId);
    this.hasCaption = this.captionSnapshots.length > 0 || this.captions.model.utterances.size > 0;
    this.transcriptStatus = state.transcriptStatus ?? "complete";
    this.transcriptExported = state.transcriptExported;
    this.committedChunks = this.journal.records.size;
    for (const header of this.journal.records.values()) {
      this.streamsUsed.add(header.stream);
      this.lastSequence.set(header.stream, Math.max(this.lastSequence.get(header.stream) ?? 0, header.seq));
    }
    for (const stream of ["meeting", "video"]) {
      if (state.expectedSequences?.[stream] || state.conversions?.some(job => job.stream === stream)) this.streamsUsed.add(stream);
    }
    this.hasVideo = this.streamsUsed.has("video");
    this.recordingStatus = state.recordingStatus;
    this.interruptionReason = state.interruptionReason;
    let manifest;
    try { manifest = await readJson(this.meetingHandle, "manifest.json"); } catch {}
    this.endedAt ??= manifest?.endedAt;
    if (state.recordingStatus !== "recording" && !Number.isFinite(this.endedAt)) {
      this.endedAt = Math.max(this.startedAt, state.muteManifest?.checkpointAt ?? 0,
        ...[...this.journal.records.values()].map(record => record.captureTs));
    }
    for (const error of state.persistenceErrors ?? manifest?.persistenceErrors ?? []) this.writeFailures.set(error.chunk, error.message);
    for (const segment of state.captureSegments ?? manifest?.captureSegments ?? []) this.segments.set(`${segment.stream}:${segment.generation}`, segment);
    this.recovery = new SessionRecovery(this);
  }

  static async restore(folderName) {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(folderName);
    const state = await readJson(directory, CAPTURE_STATE_FILE);
    const writer = new SessionWriter({ ...state, folderName, restore: true });
    await writer.ready;
    return writer;
  }

  writeChunk(streamLabel, buffer, { sessionId = this.sessionId, seq, generation = 0, captureTs = Date.now() } = {}) {
    if (this._finalizePromise) return Promise.reject(Object.assign(new Error("Session already finalized"), { retryable: false }));
    const previous = this.writeQueueByStream.get(streamLabel) ?? Promise.resolve();
    const next = previous.then(async () => {
      await this.ready;
      if (this.journal.state.recordingStatus !== "recording") throw Object.assign(new Error("Session already finalized"), { retryable: false });
      const sequence = seq ?? (this.lastSequence.get(streamLabel) ?? 0) + 1;
      const result = await this.journal.append(streamLabel, buffer, { sessionId, seq: sequence, generation, captureTs, committedAt: Date.now() });
      this.lastSequence.set(streamLabel, Math.max(this.lastSequence.get(streamLabel) ?? 0, sequence));
      this.streamsUsed.add(streamLabel); this.committedChunks = this.journal.records.size;
      this.writeFailures.delete(`${streamLabel}:${sequence}`);
      this.writeFailures.delete(`${streamLabel}:next`);
      return result;
    });
    this.writeQueueByStream.set(streamLabel, next.catch((error) => {
      this.writeFailures.set(`${streamLabel}:${seq ?? "next"}`, String(error.message ?? error));
    }));
    return next;
  }

  async checkpoint(update) {
    await this.ready;
    await this.journal.checkpoint(update);
  }

  getStorageSnapshot() {
    return { sessionId: this.sessionId, folderName: this.folderName, recordingStatus: this.journal.state.recordingStatus,
      streams: Object.fromEntries(["meeting", "video"].map((stream) => [stream, this.journal.snapshot(stream)])),
      conversions: structuredClone(this.journal.state.conversions),
      recovery: this.recovery.snapshot(), transcriptStatus: this.transcriptStatus, localIdentity: this.captions.model.localIdentity ?? null, captions: this.captions.snapshot(this.journal.state.expectedCaptionEvents) };
  }

  onCaptionEvent(event) {
    if (this._finalizePromise) return Promise.reject(Object.assign(new Error("Session already finalized"), { retryable: false }));
    const operation = this.captionQueue.then(async () => {
      await this.ready;
      if (this.journal.state.recordingStatus !== "recording") throw Object.assign(new Error("Session already finalized"), { retryable: false });
      const ack = await this.captions.append(event);
      this.hasCaption = this.captions.model.utterances.size > 0 || this.captionSnapshots.length > 0;
      return ack;
    });
    this.captionQueue = operation.catch(() => {});
    return operation;
  }

  onCaptionSnapshot(snapshot) {
    if (this._finalizePromise) return Promise.reject(Object.assign(new Error("Session already finalized"), { retryable: false }));
    const operation = this.captionQueue.then(async () => {
      await this.ready;
      this.captionSnapshots.push(snapshot);
      await this.checkpoint({ captionSnapshots: this.captionSnapshots });
      this.hasCaption = true;
    });
    this.captionQueue = operation.catch(() => {});
    return operation;
  }

  async onSpeakerLabel(label) {
    this.speakerLabels.push(label);
    await this.checkpoint({ speakerLabels: this.speakerLabels });
  }

  finalize(args) {
    if (!this._finalizePromise) {
      this._finalizePromise = this._finalizeOnce(args).catch((error) => { this._finalizePromise = null; throw error; });
    }
    return this._finalizePromise;
  }

  async _finalizeOnce({ muteManifest, endedAt, persistenceErrors = [], interruptionReason = null, expectedSequences = {}, expectedCaptionEvents = 0, captionPersistenceErrors = [] }) {
    for (const error of persistenceErrors) {
      this.writeFailures.set(error.chunk, error.message);
      const stream = error.chunk?.split(":")[0];
      if (Object.hasOwn(STREAM_FILE_NAMES, stream)) this.streamsUsed.add(stream);
    }
    // Cuando la sesión se finaliza desde un camino de emergencia (cierre de
    // pestaña/navegación, ver service-worker.js) no hay forma de reconstruir
    // el historial real de mute/unmute — vivía en la pestaña que ya se fue.
    // degraded:true dice explícitamente "no se pudo reconstruir este dato",
    // nunca "el mic nunca se desmuteó" (que sería lo que {intervals: []}
    // solo, sin la marca, parecería implicar).
    const resolvedMuteManifest = muteManifest ?? { ...(this.journal?.state.muteManifest ?? { intervals: [] }), degraded: true };
    // Se usa el momento real en que el usuario detuvo la grabación (capturado en
    // MainWorldSession.stop()), no cuándo finalize() llegó a ejecutarse acá -
    // entre medio hay envíos de mensajes y cierres de archivo que pueden demorar.
    await this.ready;
    const lastCaptureAt = Math.max(this.startedAt, this.journal.state.muteManifest?.checkpointAt ?? 0,
      ...[...this.journal.records.values()].map(record => record.captureTs));
    this.endedAt = this.endedAt ?? endedAt ?? (interruptionReason ? lastCaptureAt : Date.now());

    await Promise.all(this.writeQueueByStream.values());
    await this.captionQueue;
    await this.captions.queue;
    expectedCaptionEvents = Math.max(expectedCaptionEvents, this.journal.state.expectedCaptionEvents ?? 0);
    const captionState = this.captions.snapshot(expectedCaptionEvents);
    this.transcriptStatus = this.transcriptStatus === "incomplete" || captionPersistenceErrors.length || captionState.gaps.length || captionState.errors.length ? "incomplete" : "complete";
    expectedSequences = Object.fromEntries(["meeting", "video"].map(stream => [stream,
      Math.max(expectedSequences[stream] ?? 0, this.journal.state.expectedSequences?.[stream] ?? 0)]));
    await this.journal.checkpoint({ endedAt: this.endedAt, expectedSequences, muteManifest: resolvedMuteManifest,
      recordingStatus: "finalizing", interruptionReason, expectedCaptionEvents, captionPersistenceErrors,
      transcriptStatus: this.transcriptStatus, localIdentity: this.captions.model.localIdentity ?? null,
      persistenceErrors: [...this.writeFailures].map(([chunk, message]) => ({ chunk, message })) });
    const gaps = [...this.streamsUsed].some((stream) => this.journal.snapshot(stream).gaps.length);
    this.recordingStatus = gaps || this.writeFailures.size ? "incomplete" : "complete";
    this.interruptionReason = interruptionReason ?? (gaps ? "missing-fragments" : this.writeFailures.size ? "storage-error" : null);
    await this.journal.checkpoint({ completionStatus: this.recordingStatus, interruptionReason: this.interruptionReason });
    this.hasVideo = this.streamsUsed.has("video");
    await this.journal.checkpoint({ recordingStatus: this.recordingStatus, transcriptStatus: this.transcriptStatus });
    await this.recovery.prepare();
    await this.recovery.initialTranscriptExport();
    // Publication has its own durable task if this initial view cannot be written.
    try { await this.writeRecoveryManifest(); } catch {}
    await this.scheduleConversions(resolvedMuteManifest, this.endedAt);
    return this.getMetadata();
  }

  async exportTranscript(signal) {
    let segments;
    if (this.captions.model.utterances.size) {
      segments = this.captions.model.segments(this.startedAt, this.endedAt);
    } else {
      const parser = new CaptionParser();
      const reconciled = reconcileCaptionSnapshots({ captions: this.captionSnapshots, speakerLabels: this.speakerLabels });
      for (const snapshot of reconciled) parser.onSnapshot(snapshot);
      parser.finalizeCurrent(this.endedAt);
      segments = parser.finishedSegments.map((segment, index) => ({ index,
        startTime: segment.startMs - this.startedAt, endTime: segment.endMs - this.startedAt,
        text: segment.text, speaker: segment.speaker }));
    }
    if (!segments.length) throw Object.assign(new Error("No recoverable transcript"), { retryable: false });
    await writeFile(this.meetingHandle, "transcripcion.json", JSON.stringify(segments, null, 2), signal);
  }

  getMetadata(publicationComplete = false) {
    const status = stream => {
      const job = [...(this.journal.state.conversions ?? []), ...this.recovery.tasks].find(job => job.stream === stream);
      return !job ? "skipped" : ["waiting", "running"].includes(job.state) ? "pending" : job.state;
    };
    // Public completion describes our capture lifecycle, not the meeting's duration.
    const finalized = ["complete", "incomplete"].includes(this.recordingStatus);
    return { sessionId: this.sessionId, tabId: this.tabId, folderName: this.folderName,
      startedAt: this.startedAt, endedAt: this.endedAt, durationMs: Math.max(0, this.endedAt - this.startedAt),
      meetingTitle: this.meetingTitle, hasVideo: this.hasVideo, hasTranscript: this.transcriptExported ?? false,
      recordingStatus: finalized ? "complete" : this.recordingStatus,
      transcriptStatus: finalized ? "complete" : this.transcriptStatus, transcriptExportStatus: status("transcript"),
      audioConversionStatus: status("meeting"), videoConversionStatus: status("video"),
      hasAudioMp3: status("meeting") === "succeeded" || Boolean(this.journal.state.conversions?.find(job => job.stream === "meeting")?.outputReady),
      hasVideoMp4: status("video") === "succeeded" || Boolean(this.journal.state.conversions?.find(job => job.stream === "video")?.outputReady),
      processing: this.recovery.snapshot(publicationComplete), localIdentity: this.captions.model.localIdentity ?? null };
  }

  async writeRecoveryManifest(signal, publicationComplete = false) {
    const metadata = this.getMetadata();
    await this._writeManifest({ muteManifest: this.journal.state.muteManifest,
      audioConversionStatus: metadata.audioConversionStatus, videoConversionStatus: metadata.videoConversionStatus,
      hasAudioMp3: metadata.hasAudioMp3, hasVideoMp4: metadata.hasVideoMp4, signal, publicationComplete });
  }

  async _writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4, signal, publicationComplete = false }) {
    await writeFile(this.meetingHandle, "manifest.json",
      JSON.stringify(
        {
          persistentFormatVersion: CAPTURE_FORMAT_VERSION,
          metadataDegraded: Boolean(muteManifest?.degraded),
          recordingStatus: this.getMetadata().recordingStatus,
          startedAt: this.startedAt,
          endedAt: this.endedAt,
          durationMs: this.endedAt - this.startedAt,
          meetingTitle: this.meetingTitle,
          hasTranscript: this.transcriptExported ?? false, transcriptStatus: this.getMetadata().transcriptStatus,
          localIdentity: this.captions.model.localIdentity ?? null,
          hasVideo: this.hasVideo,
          muteManifest,
          transcriptExportStatus: this.getMetadata().transcriptExportStatus,
          processing: this.recovery.snapshot(publicationComplete),
          recoveredCoverage: this.journal.state.recoveredCoverage ?? {},
          audioConversionStatus,
          videoConversionStatus,
          hasAudioMp3: hasAudioMp3 ?? false,
          hasVideoMp4: hasVideoMp4 ?? false,
          captureSegments: [...this.segments.values()].map((entry) => ({ ...entry })),
          invalidRecords: this.journal.state.invalidRecords ?? [],
          committedChunks: this.committedChunks,
          sessionId: this.sessionId,
          persistenceErrors: [...this.writeFailures.entries()].map(([chunk, message]) => ({ chunk, message })),
        },
        null,
        2
      ), signal
    );
  }

  async resumeRecovery({ retry = false } = {}) {
    const operation = (this.recoveryOperation ?? Promise.resolve()).then(async () => {
      if (this.cancelled) throw new Error("Session deleted");
      if (this.recordingStatus === "recording") return this.recovery.snapshot();
      if (retry && this.recovery.snapshot().pending && this.recoveryScheduled) return this.recovery.snapshot();
      const damaged = [...this.streamsUsed].some(stream => this.journal.snapshot(stream).gaps.length) || this.journal.state.invalidRecords?.length;
      if (damaged) {
        this.recordingStatus = "incomplete";
        this.interruptionReason ??= "missing-fragments";
        await this.checkpoint({ recordingStatus: this.recordingStatus, interruptionReason: this.interruptionReason });
      }
      await this.recovery.prepare({ retry });
      await this.scheduleConversions(this.journal.state.muteManifest, this.endedAt);
      this.recoveryScheduled = true;
      return this.recovery.snapshot();
    });
    this.recoveryOperation = operation.catch(() => {});
    return operation;
  }

  async scheduleConversions(muteManifest, endedAt) {
    await this.ready;
    const jobs = this.journal.state.conversions;
    const finish = async () => {};
    for (const job of jobs) {
      await conversionQueue.add(job, {
        save: () => this.recovery.saveChanged(),
        changed: async () => {
          await this.recovery.publish();
          if (jobs.every(job => ["succeeded", "failed"].includes(job.state))) sendConversionMessage({ type: "asterion:conversion-finished", sessionId: this.sessionId });
        },
        input: async (signal) => {
          const segments = await this.journal.materialize(job.stream, { prefix: true, signal });
          if (!segments.length) throw Object.assign(new Error("INPUT_INVALID: no continuous saved prefix"), { retryable: false });
          for (const [key, segment] of this.segments) if (segment.stream === job.stream) this.segments.delete(key);
          for (const segment of segments) this.segments.set(`${job.stream}:${segment.generation}`, segment);
          const last = segments.at(-1);
          if (last.lastSequence < Math.max(this.lastSequence.get(job.stream) ?? 0, this.journal.state.expectedSequences?.[job.stream] ?? 0)) {
            this.recordingStatus = "incomplete";
            this.interruptionReason ??= "missing-fragments";
            this.journal.state.recordingStatus = this.recordingStatus;
            this.journal.state.interruptionReason = this.interruptionReason;
          }
          this.journal.state.recoveredCoverage ??= {};
          this.journal.state.recoveredCoverage[job.stream] = { firstSequence: segments[0].firstSequence,
            lastSequence: last.lastSequence, firstCaptureTs: segments[0].firstCaptureTs, lastCaptureTs: last.lastCaptureTs,
            partial: this.journal.snapshot(job.stream).gaps.length > 0, gaps: this.journal.snapshot(job.stream).gaps };
          await this.journal.checkpoint({ captureSegments: [...this.segments.values()] });
          const inputs = [];
          for (const segment of segments) inputs.push(new Uint8Array(await (await this.meetingHandle.getFileHandle(segment.name)).getFile().then((file) => file.arrayBuffer())));
          let args = [];
          if (job.stream === "video") {
            let response;
            try { response = await chrome.runtime.sendMessage({ type: "asterion:get-video-preset" }); } catch {}
            args = ["-fps_mode", "vfr", "-preset", response?.videoPreset ?? "medium"];
          }
          sendConversionMessage({ type: "asterion:conversion-started", sessionId: this.sessionId, meetingTitle: this.meetingTitle, stream: job.stream });
          return { reuseOutput: job.outputReady && await hasFile(this.meetingHandle, job.stream === "meeting" ? "audio-reunion.mp3" : "video-reunion.mp4"), inputs, inputExt: "webm", outputExt: job.stream === "meeting" ? "mp3" : "mp4", args, normalizeAvStreams: job.stream === "video",
            onProgress: (timeMs) => sendConversionMessage({ type: "asterion:conversion-progress", sessionId: this.sessionId, stream: job.stream,
              pct: Math.min(100, Math.round(timeMs / Math.max(1, endedAt - this.startedAt) * 100)) }) };
        },
        publish: async (bytes, token, signal) => {
          if (job.attemptId !== token) throw new Error("Obsolete conversion attempt");
          if (bytes !== null) {
            if (!bytes?.byteLength) throw new Error("Empty conversion output");
            await writeFile(this.meetingHandle, job.stream === "meeting" ? "audio-reunion.mp3" : "video-reunion.mp4", bytes, signal);
          }
          job.outputReady = true;
          await this.journal.checkpoint({ conversions: jobs });
          const segments = [...this.segments.values()].filter((segment) => segment.stream === job.stream);
          if (segments.length > 1) {
            const inputs = [];
            for (const segment of segments) inputs.push(new Uint8Array(await (await this.meetingHandle.getFileHandle(segment.name)).getFile().then((file) => file.arrayBuffer())));
            const combined = await runFfmpegAttempt({ signal, inputs, inputExt: "webm", outputExt: "webm", args: ["-c", "copy"], normalizeAvStreams: job.stream === "video" });
            if (job.attemptId !== token) throw new Error("Obsolete conversion attempt");
            await writeFile(this.meetingHandle, STREAM_FILE_NAMES[job.stream], combined, signal);
          }
        }, finish,
      });
    }
    await this.recovery.schedule();
  }

}
