const UNKNOWN_SPEAKER = "unknown";

export class CaptionParser {
  constructor() {
    this.finishedSegments = [];
    this.current = null;
  }

  onSnapshot({ speaker, text, timestampMs, captionId }) {
    const normalizedSpeaker = speaker ?? UNKNOWN_SPEAKER;
    const hasCaptionId = captionId !== undefined && captionId !== null;

    const continuesCurrent = hasCaptionId
      ? this.current?.captionId === captionId
      : this.current?.captionId === null && this.current.speaker === normalizedSpeaker;

    if (continuesCurrent) {
      this.current.text = text;
      this.current.endMs = timestampMs;
      return;
    }

    if (this.current) {
      this._finishCurrent();
    }

    this.current = {
      speaker: normalizedSpeaker,
      text,
      startMs: timestampMs,
      endMs: timestampMs,
      captionId: hasCaptionId ? captionId : null,
    };
  }

  finalizeCurrent(timestampMs) {
    if (!this.current) return;
    this.current.endMs = timestampMs;
    this._finishCurrent();
  }

  _finishCurrent() {
    const { speaker, text, startMs, endMs } = this.current;
    this.finishedSegments.push({ speaker, text, startMs, endMs });
    this.current = null;
  }
}
