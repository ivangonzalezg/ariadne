// Read only the media fields needed for recovery; no chat or captions retained.
function fields(bytes) {
  const result = new Map(); let cursor = 0;
  const integer = () => {
    let value = 0, factor = 1;
    for (let count = 0; count < 10; count++) {
      if (cursor >= bytes.length) throw new Error("Truncated media message");
      const byte = bytes[cursor++]; value += (byte & 127) * factor;
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    throw new Error("Invalid media integer");
  };
  while (cursor < bytes.length) {
    const tag = integer(), wire = tag % 8, field = Math.floor(tag / 8);
    if (!field) throw new Error("Invalid media field");
    let value;
    if (wire === 0) value = integer();
    else if (wire === 2) {
      const length = integer();
      if (length > bytes.length - cursor) throw new Error("Invalid media length");
      value = bytes.subarray(cursor, cursor + length); cursor += length;
    } else if (wire === 1 || wire === 5) {
      cursor += wire === 1 ? 8 : 4;
      if (cursor > bytes.length) throw new Error("Truncated media field");
      continue;
    } else throw new Error("Unsupported media field");
    if (!result.has(field)) result.set(field, []);
    result.get(field).push(value);
  }
  return result;
}
const nested = (message, field) => {
  const value = message.get(field)?.[0];
  return value instanceof Uint8Array ? fields(value) : new Map();
};
const string = (message, field) => {
  const value = message.get(field)?.[0];
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
};
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
  constructor({ log = () => {}, onChange = () => {} } = {}) {
    this.log = log; this.onChange = onChange; this.bySsrc = new Map(); this.devices = new Map(); this.parentDevices = new Set(); this.channels = new WeakSet();
  }
  observe(channel) {
    if (channel.label !== "collections" || this.channels.has(channel)) return;
    this.channels.add(channel);
    channel.addEventListener("message", ({ data }) => this.receive(data));
  }
  async receive(data) {
    try {
      let bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
      if (bytes.byteLength > 1048576) throw new Error("Media message too large");
      if (bytes[0] === 31 && bytes[1] === 139) {
        const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
        const parts = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.length;
            if (size > 1048576) throw new Error("Media message too large");
            parts.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        bytes = new Uint8Array(size); let position = 0;
        for (const part of parts) { bytes.set(part, position); position += part.length; }
      }
      const wrapper = nested(nested(fields(bytes), 1), 2);
      const users = nested(nested(wrapper, 13), 1).get(2) ?? [];
      for (const encoded of users) {
        const user = fields(encoded), id = string(user, 1);
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
