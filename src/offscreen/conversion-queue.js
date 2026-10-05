import { runFfmpegAttempt } from "./ffmpeg-client.js";

export const retryDelay = (attempt) => (180 + 8 ** (attempt % 6 - 1)) * 1000;
export async function deadline(operation, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new Error("JOB_TIMEOUT")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
export const terminal = (job) => ["succeeded", "failed"].includes(job.state);

// Descriptors are durable; buffers and controllers exist only during an attempt.
export class ConversionQueue {
  constructor({ now = () => Date.now(), attempt = runFfmpegAttempt, onPending = () => {} } = {}) {
    this.now = now; this.attempt = attempt; this.onPending = onPending;
    this.jobs = new Map(); this.running = false; this.timer = null;
  }

  async add(job, handlers) {
    const key = `${job.sessionId}:${job.stream}`;
    if (this.jobs.has(key) || job.settlementAttempts >= 10 || (terminal(job) && job.published)) return;
    if (job.state === "running") {
      job.state = job.attempts >= 10 ? "failed" : "waiting";
      job.nextAttemptAt = this.now(); job.error = "Interrupted processing attempt";
      await handlers.save();
    }
    if (terminal(job) && !job.settlementAttempts) job.nextAttemptAt = this.now();
    this.jobs.set(key, { job, handlers });
    this.wake();
  }

  wake() {
    clearTimeout(this.timer); this.timer = null;
    this.onPending(this.jobs.size > 0);
    if (!this.running) this.drain().catch((error) => this.onPending(true, error));
  }

  snapshot() { return [...this.jobs.values()].map(({ job }) => structuredClone(job)); }

  async cancelSession(sessionId) {
    const entries = [...this.jobs.entries()].filter(([, entry]) => entry.job.sessionId === sessionId);
    for (const [key, entry] of entries) {
      entry.cancelled = true;
      entry.job.attemptId = `${entry.job.attemptId}:cancelled`;
      entry.controller?.abort();
      this.jobs.delete(key);
    }
    // Wait for physical writes, including work that outlived a deadline.
    await Promise.allSettled(entries.flatMap(([, entry]) => [entry.operation, entry.settlement].filter(Boolean)));
    this.wake();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const eligible = [...this.jobs.entries()].filter(([, { job }]) => job.nextAttemptAt <= this.now())
          .sort((a, b) => a[1].job.nextAttemptAt - b[1].job.nextAttemptAt || a[1].job.createdAt - b[1].job.createdAt);
        if (!eligible.length) break;
        const [key, entry] = eligible[0];
        const { job, handlers } = entry;
        if (!terminal(job)) {
          job.state = "running"; job.attempts++; job.attemptId = `${job.cycle ?? 0}:${job.attempts}:${this.now()}`;
          const token = job.attemptId;
          const controller = new AbortController(); entry.controller = controller;
          entry.operation = (async () => {
            await handlers.save();
            if (controller.signal.aborted) throw new Error("Obsolete processing attempt");
            if (handlers.execute) {
              await handlers.execute(controller.signal, token);
            } else {
              const input = await deadline(handlers.input(controller.signal), 120000, () => controller.abort());
              const bytes = input.reuseOutput ? null : await this.attempt({ ...input, signal: controller.signal });
              if (job.attemptId !== token || controller.signal.aborted) throw new Error("Obsolete conversion attempt");
              await handlers.publish(bytes, token, controller.signal);
            }
            if (job.attemptId !== token || controller.signal.aborted) throw new Error("Obsolete processing attempt");
          })();
          try {
            await deadline(entry.operation, handlers.timeoutMs ?? 1680000, () => { controller.abort(); job.attemptId = `${token}:cancelled`; });
            job.state = "succeeded"; job.error = null;
          } catch (error) {
            controller.abort();
            job.error = String(error.message ?? error);
            job.state = job.attempts >= 10 || error.retryable === false || error.name === "QuotaExceededError" || /INPUT_INVALID|ASSET_UNAVAILABLE|Missing chunk|checksum|mismatch/.test(job.error) ? "failed" : "waiting";
            job.nextAttemptAt = this.now() + retryDelay(job.attempts);
          }
        }
        if (entry.cancelled) continue;
        entry.settlement = (async () => {
          try {
            await handlers.save();
            if (terminal(job)) {
              await handlers.finish(job);
              job.published = true;
              await handlers.save();
              this.jobs.delete(key);
            }
            await handlers.changed?.(job);
          } catch (error) {
            job.error = String(error.message ?? error);
            // Publication/checkpoint failures are bounded separately from encoding.
            job.settlementAttempts = (job.settlementAttempts ?? 0) + 1;
            job.nextAttemptAt = this.now() + retryDelay(job.settlementAttempts);
            if (job.settlementAttempts >= 10 || error.name === "QuotaExceededError") {
              this.jobs.delete(key);
              await handlers.onBlocked?.(job);
            }
          }
        })();
        await entry.settlement;
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

const pendingQueues = new Set();
function onPending(name, pending) {
  if (pending) pendingQueues.add(name); else pendingQueues.delete(name);
  try { chrome.runtime.sendMessage({ type: "asterion:recovery-pending", pending: pendingQueues.size > 0 }).catch(() => {}); } catch {}
}
export const conversionQueue = new ConversionQueue({ onPending: (pending) => onPending("conversion", pending) });
export const processingQueue = new ConversionQueue({ onPending: (pending) => onPending("processing", pending) });
