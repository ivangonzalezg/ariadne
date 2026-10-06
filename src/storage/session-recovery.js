import { processingQueue, terminal, retryDelay, deadline } from "../offscreen/conversion-queue.js";
import { readJson } from "./capture-journal.js";

const RECOVERY_VERSION = 2;

export async function hasFile(directory, name) {
  try { return (await (await directory.getFileHandle(name)).getFile()).size > 0; }
  catch (error) { if (error.name === "NotFoundError") return false; throw error; }
}

export async function recoverySettled(directory, state) {
  if (!state.historyPublished || state.recoveryVersion !== RECOVERY_VERSION || !["complete", "incomplete"].includes(state.recordingStatus)) return false;
  const jobs = [...(state.conversions ?? []), ...(state.recoveryTasks ?? [])];
  if (!jobs.length || jobs.some(job => !terminal(job) || !job.published)) return false;
  const publication = jobs.find(job => job.stream === "publication");
  if (!publication || (publication.state === "succeeded" && state.publishedRevision !== state.recoveryRevision)) return false;
  for (const job of jobs.filter(job => job.state === "succeeded" && job.stream !== "publication")) {
    const name = { meeting: "audio-reunion.mp3", video: "video-reunion.mp4", transcript: "transcripcion.json" }[job.stream];
    if (!name || !await hasFile(directory, name)) return false;
  }
  return true;
}

const newTask = (sessionId, stream) => ({ sessionId, stream, state: "waiting", attempts: 0,
  createdAt: Date.now(), nextAttemptAt: Date.now(), cycle: 0 });
const resetTask = (job) => Object.assign(job, { state: "waiting", attempts: 0, settlementAttempts: 0,
  nextAttemptAt: Date.now(), cycle: (job.cycle ?? 0) + 1, published: false, error: null });

// Derived artifacts can be retried without changing the integrity of captured data.
export class SessionRecovery {
  constructor(writer) { this.writer = writer; this.queue = Promise.resolve(); }
  get state() { return this.writer.journal.state; }
  get tasks() { return this.state.recoveryTasks ?? []; }

  serialize(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async prepare({ retry = false } = {}) {
    return this.serialize(async () => {
      const writer = this.writer;
      if (writer.cancelled) throw new Error("Session deleted");
      const state = this.state;
      state.conversions ??= [];
      state.recoveryTasks ??= [];
      for (const stream of writer.streamsUsed) {
        if (!state.conversions.some(job => job.stream === stream)) state.conversions.push(newTask(writer.sessionId, stream));
      }
      if (!this.tasks.some(job => job.stream === "publication")) this.tasks.push(newTask(writer.sessionId, "publication"));
      let transcript;
      try { transcript = await readJson(writer.meetingHandle, "transcripcion.json"); }
      catch (error) { if (error.name !== "NotFoundError" && !(error instanceof SyntaxError)) throw error; }
      const validTranscript = Array.isArray(transcript) && transcript.length > 0 && transcript.every(segment =>
        segment && typeof segment.text === "string" && typeof segment.speaker === "string" && Number.isFinite(segment.startTime) && Number.isFinite(segment.endTime));
      writer.transcriptExported = validTranscript;
      if (writer.hasCaption || validTranscript) {
        if (!this.tasks.some(job => job.stream === "transcript")) this.tasks.push(newTask(writer.sessionId, "transcript"));
        const task = this.tasks.find(job => job.stream === "transcript");
        if (validTranscript && task.state !== "failed" && !(state.transcriptExportError && writer.hasCaption)) {
          Object.assign(task, { state: "succeeded", published: true, error: null });
        }
        else if (task.state === "succeeded") resetTask(task);
      }
      for (const job of state.conversions) {
        const exists = await hasFile(writer.meetingHandle, job.stream === "meeting" ? "audio-reunion.mp3" : "video-reunion.mp4");
        if (!exists) job.outputReady = false;
        if (exists && (job.state === "succeeded" || !job.outputReady)) {
          Object.assign(job, { state: "succeeded", published: true, error: null, outputReady: true });
        } else if (!exists && job.state === "succeeded") resetTask(job);
      }
      for (const job of [...state.conversions, ...this.tasks]) {
        if (retry && (job.state === "failed" || job.settlementAttempts >= 10)) resetTask(job);
      }
      // Republish old presentation metadata without re-encoding existing artifacts.
      if (state.recoveryVersion !== RECOVERY_VERSION) {
        state.recoveryVersion = RECOVERY_VERSION;
        for (const coverage of Object.values(state.recoveredCoverage ?? {})) {
          coverage.partial = Boolean(coverage.gaps?.length);
        }
        state.recoveryRevision = (state.recoveryRevision ?? 0) + 1;
      }
      await writer.journal.checkpoint({ endedAt: writer.endedAt, transcriptExported: writer.transcriptExported });
    });
  }

  async saveChanged() {
    if (this.writer.cancelled) return;
    this.state.recoveryRevision = (this.state.recoveryRevision ?? 0) + 1;
    await this.writer.journal.checkpoint({ recoveryTasks: this.tasks, conversions: this.state.conversions });
  }

  async exportTranscript(signal) {
    await this.writer.exportTranscript(signal);
    if (signal?.aborted || this.writer.cancelled) throw new Error("Obsolete processing attempt");
    this.writer.transcriptExported = true;
    await this.writer.journal.checkpoint({ transcriptExported: true, transcriptExportError: null });
  }

  // Keep the existing stop contract: the first small JSON export finishes before
  // returning metadata. Its descriptor is saved before attempting the write.
  async initialTranscriptExport() {
    const task = this.tasks.find(job => job.stream === "transcript");
    if (!task || task.state !== "waiting" || task.attempts) return;
    task.state = "running"; task.attempts++;
    await this.saveChanged();
    const previousExport = this.writer.transcriptExported;
    const controller = new AbortController(); this.initialController = controller;
    this.initialExport = this.exportTranscript(controller.signal);
    try {
      await deadline(this.initialExport, 120000, () => controller.abort());
      task.state = "succeeded"; task.published = true; task.error = null;
    }
    catch (error) {
      task.error = String(error.message ?? error);
      task.state = error.name === "QuotaExceededError" || error.retryable === false ? "failed" : "waiting";
      task.nextAttemptAt = Date.now() + retryDelay(task.attempts);
      this.writer.transcriptExported = previousExport;
      this.state.transcriptExportError = task.error;
    }
    await this.saveChanged();
  }

  async schedule() {
    const task = this.tasks.find(job => job.stream === "transcript");
    if (task && !(terminal(task) && task.published)) await processingQueue.add(task, {
      save: () => this.saveChanged(), timeoutMs: 120000,
      execute: signal => this.exportTranscript(signal), finish: async () => {},
      changed: () => this.publish(),
    });
    await this.publish();
  }

  async publish() {
    if (this.writer.cancelled) return;
    const task = this.tasks.find(job => job.stream === "publication");
    if (!task) return;
    if (task.state === "succeeded" && (this.state.publishedRevision ?? -1) < (this.state.recoveryRevision ?? 0)) resetTask(task);
    if (terminal(task) && task.published) return;
    await processingQueue.add(task, {
      save: () => this.writer.journal.checkpoint({ recoveryTasks: this.tasks }), timeoutMs: 120000,
      execute: async signal => {
        const revision = this.state.recoveryRevision ?? 0;
        let manifestError;
        try { await this.writer.writeRecoveryManifest(signal, true); } catch (error) { manifestError = error; }
        if (signal.aborted || this.writer.cancelled) throw new Error("Session deleted");
        const metadata = this.writer.getMetadata(true);
        if (manifestError) {
          const publication = metadata.processing.tasks.find(job => job.stream === "publication");
          publication.state = task.attempts >= 10 || manifestError.name === "QuotaExceededError" ? "failed" : "waiting";
          publication.error = String(manifestError.message ?? manifestError);
          metadata.processing.pending = metadata.processing.tasks.some(job => !terminal(job));
          metadata.processing.canRetry = metadata.processing.tasks.some(job => job.state === "failed");
        }
        const result = await chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...metadata });
        if (!result?.ok) throw new Error(result?.error ?? "History publication unavailable");
        await this.writer.journal.checkpoint({ historyPublished: true });
        if (manifestError) throw manifestError;
        await this.writer.journal.checkpoint({ publishedRevision: revision });
      },
      finish: async () => {},
      changed: async job => {
        if (job.state === "succeeded") {
          await this.publish();
          if (this.state.conversions.every(terminal) && this.state.publishedRevision === this.state.recoveryRevision) {
            try { await chrome.runtime.sendMessage({ type: "asterion:conversion-finished", sessionId: this.writer.sessionId }); } catch {}
            await this.writer.onConversionsFinished?.();
            if (!this.snapshot().pending) await this.writer.onRecoveryFinished?.();
          }
        }
      },
    });
  }

  snapshot(publicationComplete = false) {
    const jobs = structuredClone([...(this.state.conversions ?? []), ...this.tasks]);
    if (publicationComplete) {
      const publication = jobs.find(job => job.stream === "publication");
      if (publication) Object.assign(publication, { state: "succeeded", error: null });
    }
    return { supported: true, revision: this.state.recoveryRevision ?? 0, pending: jobs.some(job => !terminal(job) && !(job.settlementAttempts >= 10)),
      canRetry: jobs.some(job => job.state === "failed" || job.settlementAttempts >= 10),
      tasks: jobs, recoveredCoverage: this.state.recoveredCoverage ?? {} };
  }
}
