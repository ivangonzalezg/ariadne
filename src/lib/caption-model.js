export const CAPTION_FORMAT_VERSION = 3;
export const captionKey = (event) => JSON.stringify([event.source, event.utteranceId]);
export const normalizeCaptionText = (text) => text.trim().replace(/\s+/g, " ");

export function validateCaptionEvent(event, sessionId) {
  if (event.kind === "local-identity") {
    if (event.sessionId !== sessionId || !Number.isSafeInteger(event.eventSeq) || event.eventSeq < 1 ||
        typeof event.identity?.speakerId !== "string" || !event.identity.speakerId ||
        typeof event.identity?.name !== "string" || !event.identity.name.trim() || event.identity.name.length > 200 ||
        event.identity.evidence !== "meet-own-camera-controls") throw Object.assign(new Error("Invalid local identity event"), { retryable: false });
    return;
  }
  if (event.kind != null || (event.isSelf != null && typeof event.isSelf !== "boolean") ||
      (event.originalSpeaker != null && typeof event.originalSpeaker !== "string") || event.sessionId !== sessionId || !Number.isSafeInteger(event.eventSeq) || event.eventSeq < 1 ||
      !["dom", "webrtc"].includes(event.source) || typeof event.utteranceId !== "string" || !event.utteranceId ||
      !Number.isSafeInteger(event.revision) || event.revision < 0 || typeof event.text !== "string" || !event.text.trim() ||
      !Number.isFinite(event.firstReceivedAt) || !Number.isFinite(event.updatedAt) || event.updatedAt < event.firstReceivedAt ||
      (event.speaker != null && typeof event.speaker !== "string") ||
      (event.speakerId != null && typeof event.speakerId !== "string") ||
      (event.supersedes != null && (!Array.isArray(event.supersedes) || !event.supersedes.every(key => typeof key === "string")))) {
    throw Object.assign(new Error("Invalid caption event"), { retryable: false });
  }
}

export class CaptionModel {
  constructor() { this.utterances = new Map(); this.superseded = new Set(); this.discarded = 0; }
  apply(event) {
    if (event.kind === "local-identity") {
      if (this.localIdentity && this.localIdentity.speakerId !== event.identity.speakerId) { this.discarded++; return false; }
      this.localIdentity = { ...event.identity }; return true;
    }
    const key = captionKey(event), previous = this.utterances.get(key);
    if (this.superseded.has(key) || (previous && event.revision <= previous.revision)) { this.discarded++; return false; }
    for (const oldKey of event.supersedes ?? []) { if (oldKey !== key) { this.superseded.add(oldKey); this.utterances.delete(oldKey); } }
    this.utterances.set(key, { ...event, firstReceivedAt: previous?.firstReceivedAt ?? event.firstReceivedAt });
    return true;
  }
  values() { return [...this.utterances.values()].sort((a, b) => a.firstReceivedAt - b.firstReceivedAt || a.eventSeq - b.eventSeq); }
  segments(startedAt, endedAt) {
    const duration = Math.max(0, endedAt - startedAt);
    const offset = (time) => Math.min(duration, Math.max(0, time - startedAt));
    return this.values().map((event, index) => ({ index, startTime: offset(event.firstReceivedAt),
      endTime: offset(event.updatedAt), text: event.text, speaker: event.isSelf && this.localIdentity ? `${this.localIdentity.name.replace(/(?: \(you\))+$/gi, "")} (you)` : event.speaker || event.speakerId || "unknown" }));
  }
}
