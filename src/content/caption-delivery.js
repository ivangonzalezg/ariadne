const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CaptionDelivery {
  constructor({ sessionId, send, recover, onAck = () => {}, onStatus = () => {}, now = () => Date.now() }) {
    Object.assign(this, { sessionId, send, recover, onAck, onStatus, now });
    this.pending = new Map(); this.eventSeq = 0; this.recoveries = 0; this.closed = false;
    this.watchdog = setInterval(() => this.check(), 1000);
  }
  add(snapshot) {
    if (this.closed || this.sealed) return;
    const event = { ...snapshot, sessionId: this.sessionId, eventSeq: ++this.eventSeq };
    this.pending.set(event.eventSeq, { event, receivedAt: this.now() });
    this.drain(); this.report(); return event;
  }
  report() { this.onStatus({ pending: this.pending.size, recoveries: this.recoveries, error: this.error?.message ?? null }); }
  async request(operation) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Caption storage timeout")), 5000);
    })]); } finally { clearTimeout(timer); }
  }
  drain() {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const [seq, entry] of this.pending) {
        if (entry.permanent || this.error) continue;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const ack = await this.request(this.send({ type: "asterion:caption-event", sessionId: this.sessionId, event: entry.event }));
            if (!ack?.durable || ack.eventSeq !== seq) throw Object.assign(new Error(ack?.error ?? "Caption not durably committed"), { permanent: ack?.retryable === false });
            this.pending.delete(seq); this.onAck(entry.event); this.report(); break;
          } catch (error) {
            if (error.permanent || error.name === "QuotaExceededError") { entry.permanent = true; this.error = error; this.report(); break; }
            if (this.error) break;
            if (attempt < 2) await delay(200 * (attempt + 1));
          }
        }
      }
    })().catch((error) => { this.error = error; this.report(); }).finally(() => { this.running = null; });
    return this.running;
  }
  async check() {
    if (this.closed || !this.pending.size || this.error) return;
    const age = this.now() - Math.min(...[...this.pending.values()].map((entry) => entry.receivedAt));
    if (age >= 30000) { this.error = new Error("Caption delivery exceeded 30 seconds"); this.report(); return; }
    if (this.recovering) return;
    if (age < 10000 || this.now() - (this.lastRecoveryAt ?? -Infinity) < 10000) return;
    if (this.recoveries >= 2) { this.error = new Error("Caption storage recovery exhausted"); this.report(); return; }
    this.recovering = true; this.recoveries++; this.lastRecoveryAt = this.now();
    try { await this.running; await this.request(this.recover()); await this.drain(); }
    catch (error) { if (this.recoveries >= 2) this.error = error; }
    finally { this.recovering = false; this.report(); }
  }
  async flush() {
    if (this.flushing) return this.flushing;
    this.sealed = true;
    this.flushing = (async () => {
      await this.running;
      while (this.pending.size && !this.error) {
        await this.check(); await this.drain();
        if (this.pending.size && !this.error) await delay(200);
      }
      this.closed = true; clearInterval(this.watchdog); this.report();
      return [...this.pending.keys()].map((eventSeq) => ({ eventSeq, message: this.error?.message ?? "Unconfirmed caption" }));
    })();
    return this.flushing;
  }
  dispose() { this.closed = true; clearInterval(this.watchdog); }
}
