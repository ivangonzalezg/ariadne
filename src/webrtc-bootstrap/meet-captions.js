import { meetMessageBytes } from "../lib/proto-wire.js";
import { decodeCaption, decodeCaptionRoster } from "./caption-decoder.js";

export class MeetCaptions {
  constructor({ onCaption, onStatus = () => {}, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { onCaption, onStatus, log, now });
    this.roster = new Map(); this.channels = new Map(); this.connections = new Map(); this.tasks = new Set(); this.epoch = 0;
  }
  observe(channel, { pc, connectionId } = {}) {
    if (!["captions", "captions_v2", "collections"].includes(channel.label) || this.channels.has(channel)) return;
    if (pc) {
      let connection = this.connections.get(connectionId);
      if (!connection) this.connections.set(connectionId, connection = { pc, labels: new Set(), lastAttempt: new Map() });
      if (channel.label === "collections") connection.labels.add("captions");
      else connection.labels.add(channel.label);
    }
    const entry = { channel, connectionId, recognized: false, incompatible: false, owned: false };
    const receive = ({ data }) => {
      if (!this.sessionId || this.mode === "dom" || !this.accepting || !this.enabled) return;
      const epoch = this.epoch, sessionId = this.sessionId, receivedAt = this.now();
      const operation = this.receive(entry, data, { epoch, sessionId, receivedAt });
      this.tasks.add(operation); operation.finally(() => this.tasks.delete(operation));
    };
    const stateChanged = () => this.report();
    entry.receive = receive; entry.stateChanged = stateChanged;
    channel.addEventListener("message", receive);
    for (const type of ["open", "close", "error"]) channel.addEventListener(type, stateChanged);
    this.channels.set(channel, entry); this.report();
  }
  start(sessionId, mode) {
    this.epoch++; this.storage = null; this.sessionId = sessionId; this.mode = mode; this.accepting = true; this.enabled = true;
    this.users = new Map(this.roster); this.utterances = new Map(); this.counters = { decoded: 0, errors: 0, stale: 0, rosterMissing: 0 };
    for (const entry of this.channels.values()) { entry.recognized = false; entry.incompatible = false; }
    if (mode !== "dom") { this.timer = setInterval(() => this.scan(), 1000); this.scan(); }
  }
  setEnabled(enabled) { this.enabled = enabled; this.report(); }
  async receive(entry, data, token) {
    try {
      const bytes = await meetMessageBytes(data);
      if (token.epoch !== this.epoch || token.sessionId !== this.sessionId) return;
      if (entry.channel.label === "collections") {
        for (const user of decodeCaptionRoster(bytes)) this.updateParticipant(user);
        return;
      }
      const decoded = decodeCaption(bytes, entry.channel.label);
      if (!decoded) { this.log("caption-control-message", { label: entry.channel.label }); return; }
      entry.recognized = true; entry.incompatible = false;
      this.counters.decoded++;
      const previous = this.utterances.get(decoded.utteranceId);
      if (previous && decoded.revision <= previous.protocolRevision) { this.counters.stale++; return; }
      const speaker = this.users.get(decoded.speakerId) ?? null;
      if (!speaker) this.counters.rosterMissing++;
      const utterance = { ...decoded, source: "webrtc", speaker, protocolRevision: decoded.revision,
        revision: previous ? previous.revision + 1 : 1,
        firstReceivedAt: previous?.firstReceivedAt ?? token.receivedAt, updatedAt: token.receivedAt };
      this.utterances.set(decoded.utteranceId, utterance);
      this.report();
      this.onCaption({ ...utterance, sessionId: token.sessionId });
    } catch (error) {
      if (token.epoch !== this.epoch) return;
      entry.incompatible = true; this.counters.errors++;
      this.log("caption-decode-error", { label: entry.channel.label, message: error.message });
    } finally { if (token.epoch === this.epoch) this.report(); }
  }
  updateParticipant(user) {
    if (!user.speaker) return;
    this.roster.set(user.speakerId, user.speaker);
    if (!this.sessionId) return;
    this.users.set(user.speakerId, user.speaker);
    for (const utterance of this.utterances.values()) {
      if (utterance.speakerId !== user.speakerId || utterance.speaker === user.speaker) continue;
      utterance.speaker = user.speaker; utterance.revision++;
      this.onCaption({ ...utterance, sessionId: this.sessionId });
    }
  }
  scan() {
    if (!this.accepting || !this.enabled) return;
    for (const [channel, entry] of this.channels) {
      if (["closing", "closed"].includes(channel.readyState)) this.detach(channel, entry);
    }
    for (const [id, connection] of this.connections) {
      if (connection.pc.connectionState === "closed") {
        this.connections.delete(id);
        for (const [channel, entry] of this.channels) if (entry.connectionId === id) this.detach(channel, entry);
        continue;
      }
      if (["disconnected", "failed"].includes(connection.pc.connectionState)) continue;
      for (const label of connection.labels) {
        const live = [...this.channels.values()].some((entry) => entry.connectionId === id && entry.channel.label === label &&
          ["open", "connecting"].includes(entry.channel.readyState));
        if (live || this.now() - (connection.lastAttempt.get(label) ?? -Infinity) < 5000) continue;
        connection.lastAttempt.set(label, this.now());
        try {
          const channel = connection.pc.createDataChannel(label, { ordered: true, maxRetransmits: 100 });
          this.observe(channel, { pc: connection.pc, connectionId: id }); this.channels.get(channel).owned = true;
          this.log("caption-channel-created", { connectionId: id, label });
        } catch (error) { this.log("caption-channel-retry", { connectionId: id, message: error.message }); }
      }
    }
    this.report();
  }
  report() {
    if (!this.sessionId || this.mode === "dom") return;
    const channels = [...this.channels.values()].filter((entry) => entry.channel.label !== "collections");
    const usable = this.enabled && channels.some((entry) => entry.channel.readyState === "open" && entry.recognized && !entry.incompatible &&
      !["disconnected", "failed", "closed"].includes(this.connections.get(entry.connectionId)?.pc.connectionState));
    this.onStatus({ sessionId: this.sessionId, usable, state: usable ? "active" : "recovering", counters: this.counters,
      channels: channels.map((entry) => ({ label: entry.channel.label, state: entry.channel.readyState, recognized: entry.recognized, incompatible: entry.incompatible })) });
  }
  async stop() {
    this.accepting = false; clearInterval(this.timer);
    await Promise.all([...this.tasks]);
    this.epoch++; this.sessionId = null;
    for (const [channel, entry] of this.channels) if (entry.owned) {
      this.detach(channel, entry); try { channel.close(); } catch { /* Already closed. */ }
    }
  }
  detach(channel, entry) {
    channel.removeEventListener("message", entry.receive);
    for (const type of ["open", "close", "error"]) channel.removeEventListener(type, entry.stateChanged);
    this.channels.delete(channel);
  }
}
