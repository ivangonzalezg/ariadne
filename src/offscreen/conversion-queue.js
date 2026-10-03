import { runFfmpegAttempt } from "./ffmpeg-client.js";

export const retryDelay = (attempt) => (180 + 8 ** (attempt % 6 - 1)) * 1000;
async function deadline(operation, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new Error("JOB_TIMEOUT")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
const terminal = (job) => ["succeeded", "failed"].includes(job.state);

// Only descriptors survive retries. Inputs are reconstructed when eligible.
export class ConversionQueue {
  constructor({ now = () => Date.now(), attempt = runFfmpegAttempt, onPending = () => {} } = {}) {
    this.now = now; this.attempt = attempt; this.onPending = onPending;
    this.jobs = new Map(); this.running = false; this.timer = null;
  }

  async add(job, handlers) {
    const key = `${job.sessionId}:${job.stream}`;
    if (this.jobs.has(key) || (terminal(job) && job.published)) return;
    if (job.state === "running") {
      job.state = job.attempts >= 10 ? "failed" : "waiting";
      job.nextAttemptAt = this.now(); job.error = "Interrupted conversion attempt";
      await handlers.save();
      if (terminal(job)) { await handlers.finish(job); job.published = true; await handlers.save(); return; }
    }
    this.jobs.set(key, { job, handlers });
    this.wake();
  }

  wake() {
    clearTimeout(this.timer); this.timer = null;
    this.onPending(this.jobs.size > 0);
    if (!this.running) this.drain().catch((error) => this.onPending(true, error));
  }

  snapshot() { return [...this.jobs.values()].map(({ job }) => structuredClone(job)); }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const eligible = [...this.jobs.entries()].filter(([, { job }]) => job.nextAttemptAt <= this.now())
          .sort((a, b) => a[1].job.nextAttemptAt - b[1].job.nextAttemptAt || a[1].job.createdAt - b[1].job.createdAt);
        if (!eligible.length) break;
        const [key, { job, handlers }] = eligible[0];
        if (terminal(job)) {
          try { await handlers.save(); await handlers.finish(job); job.published = true; await handlers.save(); this.jobs.delete(key); }
          catch (error) { job.error = String(error.message ?? error); job.nextAttemptAt = this.now() + 60000; }
          continue;
        }
        job.state = "running"; job.attempts++; job.attemptId = `${job.attempts}:${this.now()}`;
        const token = job.attemptId;
        const controller = new AbortController();
        const execute = async () => {
          await handlers.save();
          const input = await deadline(handlers.input(controller.signal), 120000, () => controller.abort());
          const bytes = await this.attempt({ ...input, signal: controller.signal });
          if (job.attemptId !== token || controller.signal.aborted) throw new Error("Obsolete conversion attempt");
          await handlers.publish(bytes, token, controller.signal);
          if (job.attemptId !== token || controller.signal.aborted) throw new Error("Obsolete conversion attempt");
        };
        try {
          await deadline(execute(), 1680000, () => { controller.abort(); job.attemptId = `${token}:cancelled`; });
          job.state = "succeeded"; job.error = null;
        } catch (error) {
          controller.abort();
          job.error = String(error.message ?? error);
          job.state = job.attempts >= 10 || error.retryable === false || /INPUT_INVALID|ASSET_UNAVAILABLE|Missing chunk|checksum|mismatch/.test(job.error) ? "failed" : "waiting";
          job.nextAttemptAt = this.now() + retryDelay(job.attempts);
        }
        try {
          await handlers.save();
          if (terminal(job)) { await handlers.finish(job); job.published = true; await handlers.save(); this.jobs.delete(key); }
        } catch (error) {
          job.error = String(error.message ?? error);
          job.nextAttemptAt = this.now() + 60000;
        }
      }
    } finally {
      this.running = false;
      this.onPending(this.jobs.size > 0);
      if (this.jobs.size) {
        const due = Math.min(...[...this.jobs.values()].map(({ job }) => job.nextAttemptAt));
        this.timer = setTimeout(() => this.wake(), Math.max(10, due - this.now()));
      }
    }
  }
}

export const conversionQueue = new ConversionQueue({ onPending: (pending) => {
  try { chrome.runtime.sendMessage({ type: "asterion:recovery-pending", pending }).catch(() => {}); } catch {}
} });
