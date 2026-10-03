// Structural recovery; acoustic silence is diagnostic, never a removal rule.
export class CaptureHealth {
  constructor({ getSession, getMixer, scan, restart, getRemoteMicState = () => null, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { getSession, getMixer, scan, restart, getRemoteMicState, log, now });
    this.timers = new Set();
    this.suspicions = new Map();
    this.lastReconnect = new Map();
    this.active = false;
  }
  timeout(callback, delay) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.active) callback(); }, delay);
    this.timers.add(timer); return timer;
  }
  start() {
    this.stop(); this.active = true;
    this.checks = 0; this.suspended = 0; this.smallChunks = 0; this.smallAttempts = 0; this.storageAttempts = 0; this.restartCount = 0; this.lastRestartReason = null;
    this.timeout(() => this.check(false), 5000);
    this.periodic = this.timeout(() => this.check(true), 10000);
    this.timeout(() => {
      const mixer = this.getMixer();
      if (!mixer.htmlSources.size && !mixer.playbackSources.size) this.log("hybrid-remote-sources-absent", {});
      this.checkStorage();
    }, 10000);
  }
  stop() {
    this.active = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.eventTimer = null;
    this.suspicions.clear(); this.lastReconnect.clear();
  }
  schedule() {
    if (!this.active) return;
    if (this.eventTimer) { clearTimeout(this.eventTimer); this.timers.delete(this.eventTimer); }
    this.eventTimer = this.timeout(() => { this.eventTimer = null; this.check(false); }, 3000);
  }
  chunk(size) {
    if (!this.active) return;
    if (size > 500) { this.smallChunks = 0; this.smallAttempts = 0; return; }
    this.smallChunks++;
    if (this.smallChunks % 5 === 0 && this.smallAttempts < 3) {
      this.smallAttempts++;
      try { this.scan(); } catch (error) { this.log("small-chunks-recovery-error", { message: error.message }); }
      this.log("small-chunks-recovery", { attempt: this.smallAttempts });
    }
  }
  async checkStorage() {
    if (!this.active) return;
    if (this.getSession()?.committedChunks || this.storageAttempts >= 2) return;
    this.storageAttempts++;
    await this.recover("no-persisted-chunks");
    if (this.active) this.timeout(() => this.checkStorage(), 10000);
  }
  getSnapshot() {
    return { active: this.active, healthyChecks: this.checks ?? 0, restarts: this.restartCount ?? 0, lastRestartReason: this.lastRestartReason ?? null, smallChunkAttempts: this.smallAttempts ?? 0, storageAttempts: this.storageAttempts ?? 0 };
  }
  async recover(reason) {
    if (!this.active || this.getSession()?.stopping) return;
    this.restartCount++; this.lastRestartReason = reason;
    try { await this.restart(reason); }
    catch (error) { this.log("capture-restart-error", { reason, message: error.message }); }
  }
  async check(periodic) {
    if (!this.active) return;
    let healthy = true;
    try {
      const mixer = this.getMixer(), session = this.getSession();
      if (!session || session.stopping) return;
      if (mixer.audioContext.state === "closed") { healthy = false; await this.recover("context-closed"); }
      else if (mixer.audioContext.state !== "running") {
        healthy = false; this.suspended++;
        if (this.suspended >= 3) { await this.recover("context-persistently-suspended"); this.suspended = 0; }
        else await mixer.resume();
      } else {
        this.suspended = 0;
        if (session.meetingRecorder?.state !== "recording") { healthy = false; await this.recover("recorder-not-recording"); }
      }
      if (this.active) { this.scan(); this.inspectMutedSources(); }
    } catch (error) { healthy = false; this.log("capture-health-error", { message: error.message }); }
    if (periodic && this.active) {
      this.checks = healthy ? this.checks + 1 : 0;
      this.periodic = this.timeout(() => this.check(true), this.checks >= 12 ? 30000 : 10000);
    }
  }
  inspectMutedSources() {
    const mixer = this.getMixer();
    for (const [key, entry] of mixer.remoteSources) {
      const micOn = this.getRemoteMicState(entry);
      entry.announcedMicOn = micOn;
      const tracks = entry.stream?.getAudioTracks?.() ?? [entry.track];
      const allMuted = tracks.length > 0 && tracks.every((track) => track.muted || !track.enabled);
      if (!allMuted || micOn !== true) { this.suspicions.delete(key); continue; }
      const count = (this.suspicions.get(key) ?? 0) + 1;
      this.suspicions.set(key, count);
      if (count < 2 || this.now() - (this.lastReconnect.get(key) ?? -Infinity) < 60000) continue;
      if (!mixer.reconnectRemoteStream(key)) continue;
      this.lastReconnect.set(key, this.now()); this.schedule();
      this.log("announced-mic-source-reconnected", { key, count });
    }
  }
}
