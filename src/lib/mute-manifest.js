export class MuteManifest {
  constructor({ startedAt }) {
    this.startedAt = startedAt;
    this.intervals = [];
    this.openIntervalStartMs = null;
  }

  onUnmuted(timestampMs) {
    if (this.openIntervalStartMs !== null) return;
    this.openIntervalStartMs = timestampMs - this.startedAt;
  }

  onMuted(timestampMs) {
    if (this.openIntervalStartMs === null) return;
    this.intervals.push({
      startMs: this.openIntervalStartMs,
      endMs: timestampMs - this.startedAt,
    });
    this.openIntervalStartMs = null;
  }

  finalize(timestampMs) {
    if (this.openIntervalStartMs !== null) {
      this.onMuted(timestampMs);
    }
  }

  toJSON() {
    return { intervals: this.intervals };
  }
}
