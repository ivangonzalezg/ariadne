// src/storage/session-writer.js
import { CaptionJournal } from "./caption-journal.js";
import { CaptionParser } from "../lib/caption-parser.js";
import { reconcileCaptionSnapshots } from "../lib/speaker-label-reconciler.js";
import { runFfmpegAttempt } from "../offscreen/ffmpeg-client.js";
import { CaptureJournal, CAPTURE_FORMAT_VERSION, readJson, CAPTURE_STATE_FILE, writeFile } from "./capture-journal.js";
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
    this.hasVideo = this.streamsUsed.has("video");
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
      transcriptStatus: this.transcriptStatus, captions: this.captions.snapshot(this.journal.state.expectedCaptionEvents) };
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
    this.endedAt = endedAt ?? Date.now();
    await this.ready;

    await Promise.all(this.writeQueueByStream.values());
    await this.captionQueue;
    await this.captions.queue;
    expectedCaptionEvents = Math.max(expectedCaptionEvents, this.journal.state.expectedCaptionEvents ?? 0);
    const captionState = this.captions.snapshot(expectedCaptionEvents);
    this.transcriptStatus = this.transcriptStatus === "incomplete" || interruptionReason || captionPersistenceErrors.length || captionState.gaps.length || captionState.errors.length ? "incomplete" : "complete";
    await this.journal.checkpoint({ endedAt: this.endedAt, expectedSequences, muteManifest: resolvedMuteManifest,
      recordingStatus: "finalizing", interruptionReason, expectedCaptionEvents, captionPersistenceErrors,
      transcriptStatus: this.transcriptStatus });
    const gaps = [...this.streamsUsed].some((stream) => this.journal.snapshot(stream).gaps.length);
    this.recordingStatus = interruptionReason || gaps || this.writeFailures.size ? "incomplete" : "complete";
    this.interruptionReason = interruptionReason ?? (gaps ? "missing-fragments" : this.writeFailures.size ? "storage-error" : null);
    await this.journal.checkpoint({ completionStatus: this.recordingStatus, interruptionReason: this.interruptionReason });
    for (const stream of this.streamsUsed) {
      const segments = await this.journal.materialize(stream, { prefix: this.recordingStatus === "incomplete" });
      for (const segment of segments) this.segments.set(`${stream}:${segment.generation}`, segment);
    }


    if (this.hasCaption) {
      let segments;
      if (this.captions.model.utterances.size) {
        // Protocol/DOM identity supplies attribution. Never guess a speaker from audio timing.
        segments = this.captions.model.segments(this.startedAt, this.endedAt);
      } else {
        // Existing sessions keep the historical snapshot contract.
        this.captionParser = new CaptionParser();
        const reconciled = reconcileCaptionSnapshots({ captions: this.captionSnapshots, speakerLabels: this.speakerLabels });
        for (const snapshot of reconciled) this.captionParser.onSnapshot(snapshot);
        this.captionParser.finalizeCurrent(this.endedAt);
        segments = this.captionParser.finishedSegments.map((segment, index) => ({ index,
          startTime: segment.startMs - this.startedAt, endTime: segment.endMs - this.startedAt,
          text: segment.text, speaker: segment.speaker }));
      }
      try {
        await writeFile(this.meetingHandle, "transcripcion.json", JSON.stringify(segments, null, 2));
        this.transcriptExported = true;
      } catch (error) {
        this.transcriptStatus = "incomplete"; this.transcriptExported = false;
        await this.journal.checkpoint({ transcriptExportError: error.message });
      }
    }

    this.hasVideo = this.streamsUsed.has("video");
    await this._writeManifest({
      muteManifest: resolvedMuteManifest,
      audioConversionStatus: this.streamsUsed.has("meeting") ? this.recordingStatus === "incomplete" ? "failed" : "pending" : "skipped",
      videoConversionStatus: this.hasVideo ? this.recordingStatus === "incomplete" ? "failed" : "pending" : "skipped",
    });

    await this.journal.checkpoint({ recordingStatus: this.recordingStatus, transcriptStatus: this.transcriptStatus,
      transcriptExported: this.transcriptExported ?? false });
    // Persist the job descriptors before returning; execution stays asynchronous.
    await this.scheduleConversions(resolvedMuteManifest, this.endedAt);

    return {
      recordingStatus: this.recordingStatus, interruptionReason: this.interruptionReason,
      sessionId: this.sessionId,
      tabId: this.tabId,
      folderName: this.meetingHandle.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.endedAt - this.startedAt,
      meetingTitle: this.meetingTitle,
      hasTranscript: this.transcriptExported ?? this.hasCaption, transcriptStatus: this.transcriptStatus,
      hasVideo: this.hasVideo,
    };
  }

  async _writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 }) {
    const manifestHandle = await this.meetingHandle.getFileHandle("manifest.json", { create: true });
    const manifestWritable = await manifestHandle.createWritable();
    await manifestWritable.write(
      JSON.stringify(
        {
          persistentFormatVersion: CAPTURE_FORMAT_VERSION,
          metadataDegraded: Boolean(this.interruptionReason || muteManifest?.degraded),
          recordingStatus: this.recordingStatus, interruptionReason: this.interruptionReason,
          startedAt: this.startedAt,
          endedAt: this.endedAt,
          durationMs: this.endedAt - this.startedAt,
          meetingTitle: this.meetingTitle,
          hasTranscript: this.transcriptExported ?? this.hasCaption, transcriptStatus: this.transcriptStatus,
          hasVideo: this.hasVideo,
          muteManifest,
          audioConversionStatus,
          videoConversionStatus,
          hasAudioMp3: hasAudioMp3 ?? false,
          hasVideoMp4: hasVideoMp4 ?? false,
          captureSegments: [...this.segments.values()].map((entry) => ({ ...entry })),
          committedChunks: this.committedChunks,
          sessionId: this.sessionId,
          persistenceErrors: [...this.writeFailures.entries()].map(([chunk, message]) => ({ chunk, message })),
        },
        null,
        2
      )
    );
    await manifestWritable.close();
  }

  async scheduleConversions(muteManifest, endedAt) {
    await this.ready;
    if (this.journal.state.recordingStatus === "incomplete") {
      sendConversionMessage({ type: "asterion:conversion-finished", sessionId: this.sessionId });
      await this.onConversionsFinished?.(); return;
    }
    const jobs = this.journal.state.conversions;
    for (const stream of this.streamsUsed) {
      if (!jobs.some((job) => job.stream === stream)) jobs.push({ sessionId: this.sessionId, stream,
        inputs: [...this.segments.values()].filter((segment) => segment.stream === stream).map((segment) => segment.name),
        attempts: 0, state: "waiting", createdAt: Date.now(), nextAttemptAt: Date.now() });
    }
    await this.journal.checkpoint({ conversions: jobs });
    const finish = async () => {
      const audio = jobs.find((job) => job.stream === "meeting");
      const video = jobs.find((job) => job.stream === "video");
      await this._writeManifest({ muteManifest, audioConversionStatus: audio?.state === "waiting" || audio?.state === "running" ? "pending" : audio?.state ?? "skipped",
        videoConversionStatus: video?.state === "waiting" || video?.state === "running" ? "pending" : video?.state ?? "skipped",
        hasAudioMp3: audio?.state === "succeeded", hasVideoMp4: video?.state === "succeeded" });
      if (jobs.every((job) => ["succeeded", "failed"].includes(job.state))) {
        sendConversionMessage({ type: "asterion:conversion-finished", sessionId: this.sessionId });
        await this.onConversionsFinished?.();
      }
    };
    for (const job of jobs) {
      await conversionQueue.add(job, {
        save: () => this.journal.checkpoint({ conversions: jobs }),
        input: async () => {
          const segments = await this.journal.materialize(job.stream);
          for (const segment of segments) this.segments.set(`${job.stream}:${segment.generation}`, segment);
          const inputs = [];
          for (const segment of segments) inputs.push(new Uint8Array(await (await this.meetingHandle.getFileHandle(segment.name)).getFile().then((file) => file.arrayBuffer())));
          let args = [];
          if (job.stream === "video") {
            let response;
            try { response = await chrome.runtime.sendMessage({ type: "asterion:get-video-preset" }); } catch {}
            args = ["-fps_mode", "vfr", "-preset", response?.videoPreset ?? "medium"];
          }
          sendConversionMessage({ type: "asterion:conversion-started", sessionId: this.sessionId, meetingTitle: this.meetingTitle, stream: job.stream });
          return { inputs, inputExt: "webm", outputExt: job.stream === "meeting" ? "mp3" : "mp4", args, normalizeAvStreams: job.stream === "video",
            onProgress: (timeMs) => sendConversionMessage({ type: "asterion:conversion-progress", sessionId: this.sessionId, stream: job.stream,
              pct: Math.min(100, Math.round(timeMs / Math.max(1, endedAt - this.startedAt) * 100)) }) };
        },
        publish: async (bytes, token, signal) => {
          if (job.attemptId !== token) throw new Error("Obsolete conversion attempt");
          await writeFile(this.meetingHandle, job.stream === "meeting" ? "audio-reunion.mp3" : "video-reunion.mp4", bytes, signal);
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
    if (!jobs.length) await finish();
  }

}
