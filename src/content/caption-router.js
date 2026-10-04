import { captionKey, normalizeCaptionText } from "../lib/caption-model.js";

export class CaptionRouter {
  constructor({ sessionId, mode = "dom", emit, log = () => {} }) {
    Object.assign(this, { sessionId, mode, emit, log });
    this.candidates = new Map(); this.canonical = new Map(); this.aliases = new Map(); this.rtcUsable = false;
  }
  setRtcStatus(status) {
    if (status.sessionId !== this.sessionId) return;
    const wasUsable = this.rtcUsable; this.rtcUsable = Boolean(status.usable);
    if (wasUsable && !this.rtcUsable && this.mode === "hybrid") {
      this.log("caption-source-fallback", { source: "dom" });
      for (const event of this.candidates.values()) if (event.source === "dom") this.publish(event);
    }
  }
  receive(event) {
    if (event.sessionId && event.sessionId !== this.sessionId) return;
    const key = captionKey(event), previous = this.candidates.get(key);
    if (previous && event.revision <= previous.revision) return;
    this.candidates.set(key, event);
    if (this.mode === "shadow" && event.source === "webrtc") {
      this.log("caption-shadow-comparison", { matched: this.matches(event).length === 1, revision: event.revision }); return;
    }
    const primary = this.mode === "hybrid" && this.rtcUsable ? "webrtc" : "dom";
    if (event.source !== primary) return;
    this.publish(event);
  }
  matches(event) {
    if (!event.speaker) return [];
    return [...this.canonical.entries()].filter(([, candidate]) => candidate.source !== event.source && candidate.speaker === event.speaker &&
      normalizeCaptionText(candidate.text) === normalizeCaptionText(event.text) && Math.abs(candidate.firstReceivedAt - event.firstReceivedAt) <= 3000);
  }
  publish(event) {
    const key = captionKey(event);
    let canonicalKey = this.aliases.get(key) ?? key;
    if (!this.canonical.has(canonicalKey)) {
      const matches = this.matches(event);
      if (matches.length === 1) { canonicalKey = matches[0][0]; this.aliases.set(key, canonicalKey); }
      else if (matches.length > 1) this.log("caption-ambiguous-match", { count: matches.length });
    }
    let previous = this.canonical.get(canonicalKey);
    const supersedes = [];
    // Partial DOM and RTC text can converge only after both have been published.
    // Merge only exact, unique matches and persist the supersession for replay.
    const allMatches = this.matches(event);
    const matches = allMatches.length === 1 ? allMatches.filter(([matchKey]) => matchKey !== canonicalKey) : [];
    if (previous && matches.length === 1) {
      const [matchKey, match] = matches[0];
      const keepKey = previous.firstReceivedAt <= match.firstReceivedAt ? canonicalKey : matchKey;
      const removeKey = keepKey === canonicalKey ? matchKey : canonicalKey;
      const owner = this.canonical.get(keepKey);
      previous = { ...owner, revision: Math.max(previous.revision, match.revision),
        updatedAt: Math.max(previous.updatedAt, match.updatedAt) };
      this.canonical.delete(removeKey); supersedes.push(removeKey);
      for (const [alias, target] of this.aliases) if (target === removeKey) this.aliases.set(alias, keepKey);
      this.aliases.set(removeKey, keepKey); this.aliases.set(key, keepKey); canonicalKey = keepKey;
    }
    if (!supersedes.length && previous && previous.text === event.text && previous.speaker === event.speaker && previous.isFinal === (event.isFinal ?? previous.isFinal) && previous.language === (event.language ?? previous.language)) return;
    const metadata = Object.fromEntries(["language", "isFinal", "protocolTimestamp", "translationLanguage"].filter(field => event[field] == null && previous?.[field] != null).map(field => [field, previous[field]]));
    const canonical = { ...metadata, ...event, source: previous?.source ?? event.source, utteranceId: previous?.utteranceId ?? event.utteranceId,
      firstReceivedAt: previous?.firstReceivedAt ?? event.firstReceivedAt, updatedAt: Math.max(previous?.updatedAt ?? 0, event.updatedAt),
      revision: previous ? previous.revision + 1 : 1, observedSource: event.source,
      ...(supersedes.length ? { supersedes } : {}) };
    this.canonical.set(canonicalKey, canonical); this.emit(canonical);
  }
}
