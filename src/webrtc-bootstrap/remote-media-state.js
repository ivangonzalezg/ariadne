import { fields, nested, string, meetMessageBytes } from "../lib/proto-wire.js";

export function decodeMediaStates(bytes) {
  const wrapper = nested(nested(fields(bytes), 1), 2);
  const media = nested(wrapper, 3);
  return (media.get(2) ?? []).map((encoded) => {
    const entry = fields(encoded);
    return { type: entry.get(2)?.[0], ssrc: string(entry, 4), deviceId: string(entry, 6),
      muted: nested(entry, 10).get(1)?.[0] ?? null };
  }).filter((entry) => entry.type === 1 && entry.deviceId && [0, 1, null].includes(entry.muted));
}

export class RemoteMediaState {
  constructor({ log = () => {}, onChange = () => {}, onParticipant = () => {} } = {}) {
    this.log = log; this.onChange = onChange; this.onParticipant = onParticipant; this.bySsrc = new Map(); this.devices = new Map(); this.parentDevices = new Set(); this.channels = new WeakSet();
  }
  observe(channel) {
    if (channel.label !== "collections" || this.channels.has(channel)) return;
    this.channels.add(channel);
    channel.addEventListener("message", ({ data }) => this.receive(data));
  }
  async receive(data) {
    try {
      const bytes = await meetMessageBytes(data);
      const wrapper = nested(nested(fields(bytes), 1), 2);
      const users = nested(nested(wrapper, 13), 1).get(2) ?? [];
      for (const encoded of users) {
        const user = fields(encoded), id = string(user, 1);
        if (id) this.onParticipant({ speakerId: id, speaker: string(user, 2) || string(user, 29) || null });
        if (string(user, 21)) this.parentDevices.add(id);
        else this.parentDevices.delete(id);
      }
      for (const entry of decodeMediaStates(bytes)) {
        if (this.bySsrc.size >= 4096 && !this.bySsrc.has(entry.ssrc)) this.bySsrc.delete(this.bySsrc.keys().next().value);
        if (entry.ssrc) this.bySsrc.set(entry.ssrc, entry.deviceId);
        if (entry.muted !== null) this.devices.set(entry.deviceId, entry.muted === 0);
      }
      for (const collection of [this.devices, this.parentDevices]) {
        while (collection.size > 4096) collection.delete(collection.keys().next().value);
      }
      this.onChange();
    } catch (error) {
      this.bySsrc.clear(); this.devices.clear(); this.parentDevices.clear();
      this.log("remote-media-state-unavailable", { message: error.message });
    }
  }
  get(receiver) {
    try {
      for (const source of receiver?.getSynchronizationSources?.() ?? []) {
        const id = this.bySsrc.get(String(source.source));
        if (id && !this.parentDevices.has(id)) return this.devices.get(id) ?? null;
      }
    } catch { /* Missing metadata is not evidence of a broken source. */ }
    return null;
  }
}
