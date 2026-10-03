import { arrayBufferToBase64 } from "../lib/base64.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class ChunkDelivery {
  constructor({ sessionId, send, recover, onAck, onFatal, onStatus = () => {}, now = () => Date.now() }) {
    Object.assign(this, { sessionId, send, recover, onAck, onFatal, onStatus, now });
    this.commitsByStream = {};
    this.pending = new Map(); this.bytes = 0; this.lastCommitAt = null; this.recoveries = 0;
    this.running = null; this.closed = false; this.fatal = null;
    this.watchdog = setInterval(() => this.check().catch((error) => this.fail(error)), 1000);
  }

  add(message) {
    if (message.sessionId !== this.sessionId) throw new Error("Session mismatch");
    const key = `${message.stream}:${message.generation}:${message.seq}`;
    if (this.pending.has(key)) return;
    this.pending.set(key, { message, receivedAt: this.now(), attempted: false, bytes: message.buffer.byteLength });
    this.bytes += message.buffer.byteLength;
    if (this.bytes > 128 * 1024 * 1024) this.fail(new Error("Pending audio exceeds memory limit"));
    this.drain(); this.report();
  }

  report() {
    this.onStatus({ sessionId: this.sessionId, pending: this.pending.size, pendingBytes: this.bytes,
      oldestPendingAt: this.pending.size ? Math.min(...[...this.pending.values()].map((entry) => entry.receivedAt)) : null,
      streams: structuredClone(this.commitsByStream),
      pendingChunks: [...this.pending.values()].map(({ message }) => ({ stream: message.stream, generation: message.generation, seq: message.seq })),
      lastCommitAt: this.lastCommitAt, storageRecoveries: this.recoveries, error: this.fatal?.message ?? null });
  }

  async request(message, operation = this.send(message)) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Storage transport timeout")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }

  drain() {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const [key, entry] of this.pending) {
        entry.attempted = true;
        if (entry.permanent || entry.bytes > 128 * 1024 * 1024) continue;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { buffer, source, ...metadata } = entry.message;
            const result = await this.request({ ...metadata, bufferBase64: arrayBufferToBase64(buffer) });
            if (!result?.committed || !result.durable) {
              throw Object.assign(new Error(result?.error ?? "Chunk not durably committed"), { permanent: result?.retryable === false });
            }
            this.pending.delete(key); this.bytes -= entry.bytes; this.lastCommitAt = this.now();
            this.commitsByStream[metadata.stream] = { lastCommitAt: this.lastCommitAt, gaps: result.gaps ?? [], pendingSequences: result.pendingSequences ?? [] };
            this.onAck({ ...metadata, ...result }); this.report(); break;
          } catch (error) {
            if (error.permanent) { entry.permanent = true; this.fail(error); break; }
            if (this.fatal) break;
            if (attempt < 2) await delay(200 * (attempt + 1));
          }
        }
      }
    })().finally(() => {
      this.running = null;
      if ([...this.pending.values()].some((entry) => !entry.attempted)) this.drain();
    });
    return this.running;
  }

  fail(error) {
    if (this.fatal) return;
    this.fatal = error; this.onFatal(error); this.report();
  }

  async check() {
    if (!this.pending.size || this.closed) return;
    const oldest = Math.min(...[...this.pending.values()].map((entry) => entry.receivedAt));
    if (this.now() - oldest >= 30000) { this.fail(new Error("Pending audio exceeds 30 second limit")); return; }
    if (this.recovering) return;
    if (this.fatal || (this.now() - oldest < 10000 && this.now() - (this.lastCommitAt ?? oldest) < 10000)) return;
    if (this.recoveries >= 2) { this.fail(new Error("Storage recovery exhausted")); return; }
    if (this.lastRecoveryAt && this.now() - this.lastRecoveryAt < 10000) return;
    this.lastRecoveryAt = this.now();
    this.recovering = true; this.recoveries++; this.report();
    try { await this.request(null, this.recover()); await this.drain(); }
    catch (error) { if (this.recoveries >= 2) this.fail(error); }
    finally { this.recovering = false; }
  }

  async flush() {
    await this.drain();
    while (this.pending.size && !this.fatal) {
      await this.check();
      if (this.pending.size && !this.fatal) await delay(200);
    }
    clearInterval(this.watchdog); this.closed = true;
    return [...this.pending.values()].map(({ message }) => ({ chunk: `${message.stream}:${message.seq}`, message: this.fatal?.message ?? "Unconfirmed chunk" }));
  }
}
