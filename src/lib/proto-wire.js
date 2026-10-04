// Minimal protobuf wire reader shared by Meet media and caption adapters.
export function fields(bytes) {
  const result = new Map(); let cursor = 0;
  const integer = () => {
    let value = 0n;
    for (let count = 0; count < 10; count++) {
      if (cursor >= bytes.length) throw new Error("Truncated protobuf message");
      const byte = bytes[cursor++];
      if (count === 9 && byte > 1) throw new Error("Invalid protobuf integer");
      value |= BigInt(byte & 127) << BigInt(count * 7);
      if (!(byte & 128)) return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    }
    throw new Error("Invalid protobuf integer");
  };
  while (cursor < bytes.length) {
    const tag = integer();
    if (typeof tag !== "number" || !tag || tag > 0xffffffff) throw new Error("Invalid protobuf field");
    const wire = tag % 8, field = Math.floor(tag / 8); let value;
    if (!field) throw new Error("Invalid protobuf field");
    if (wire === 0) value = integer();
    else if (wire === 2) {
      const length = integer();
      if (typeof length !== "number" || length > bytes.length - cursor) throw new Error("Invalid protobuf length");
      value = bytes.subarray(cursor, cursor + length); cursor += length;
    } else if (wire === 1 || wire === 5) {
      cursor += wire === 1 ? 8 : 4;
      if (cursor > bytes.length) throw new Error("Truncated protobuf field");
      continue;
    } else throw new Error("Unsupported protobuf wire type");
    if (!result.has(field)) result.set(field, []);
    result.get(field).push(value);
  }
  return result;
}
export const nested = (message, field) => {
  const value = message.get(field)?.[0];
  return value instanceof Uint8Array ? fields(value) : new Map();
};
export const string = (message, field) => {
  const value = message.get(field)?.[0];
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
};
export const MAX_MEET_MESSAGE_BYTES = 1048576;
export async function meetMessageBytes(data) {
  if (data?.size > MAX_MEET_MESSAGE_BYTES || data?.byteLength > MAX_MEET_MESSAGE_BYTES) throw new Error("Meet message too large");
  let bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) :
    data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!bytes) throw new Error("Unsupported Meet message data");
  if (bytes.length > MAX_MEET_MESSAGE_BYTES) throw new Error("Meet message too large");
  if (bytes[0] !== 31 || bytes[1] !== 139) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_MEET_MESSAGE_BYTES) throw new Error("Meet message too large");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
