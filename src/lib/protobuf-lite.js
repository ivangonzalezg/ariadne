const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_VARINT_BYTES = 10;
const MAX_GROUP_DEPTH = 16;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function readVarint(bytes, offset) {
  let value = 0n;

  for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
    const position = offset + index;
    if (position >= bytes.length) return null;

    const byte = bytes[position];
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) {
      return { value, offset: position + 1 };
    }
  }

  return null;
}

function asNumberOrBigInt(value) {
  return value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : value;
}

function readFixed64(bytes, offset) {
  if (offset + 8 > bytes.length) return null;

  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  }
  return { value: asNumberOrBigInt(value), offset: offset + 8 };
}

function readFixed32(bytes, offset) {
  if (offset + 4 > bytes.length) return null;

  const value = bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24);
  return { value: value >>> 0, offset: offset + 4 };
}

function skipGroup(bytes, offset, end, expectedField, depth) {
  if (depth >= MAX_GROUP_DEPTH) return null;

  while (offset < end) {
    const key = readVarint(bytes, offset);
    if (!key) return null;
    offset = key.offset;

    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 0x7n);
    if (field === 0 || !Number.isSafeInteger(field)) return null;
    if (wire === 4) return field === expectedField ? offset : null;

    if (wire === 0) {
      const parsed = readVarint(bytes, offset);
      if (!parsed) return null;
      offset = parsed.offset;
    } else if (wire === 1) {
      if (offset + 8 > end) return null;
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value > MAX_SAFE_INTEGER_BIGINT) return null;
      offset = length.offset;
      const lengthNumber = Number(length.value);
      if (lengthNumber > end - offset) return null;
      offset += lengthNumber;
    } else if (wire === 3) {
      const nestedEnd = skipGroup(bytes, offset, end, field, depth + 1);
      if (nestedEnd === null) return null;
      offset = nestedEnd;
    } else if (wire === 5) {
      if (offset + 4 > end) return null;
      offset += 4;
    } else {
      return null;
    }
  }

  return null;
}

function walk(bytes, callback, start, end) {
  let offset = start;

  while (offset < end) {
    const key = readVarint(bytes, offset);
    if (!key) return false;
    offset = key.offset;

    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 0x7n);
    if (field === 0 || !Number.isSafeInteger(field)) return false;

    if (wire === 4) return false;

    if (wire === 0) {
      const parsed = readVarint(bytes, offset);
      if (!parsed) return false;
      offset = parsed.offset;
      callback({ field, wire, value: asNumberOrBigInt(parsed.value), bytes: null });
      continue;
    }

    if (wire === 1) {
      const parsed = readFixed64(bytes, offset);
      if (!parsed) return false;
      offset = parsed.offset;
      callback({ field, wire, value: parsed.value, bytes: null });
      continue;
    }

    if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value > MAX_SAFE_INTEGER_BIGINT) return false;
      offset = length.offset;
      const lengthNumber = Number(length.value);
      if (lengthNumber > end - offset) return false;
      const fieldBytes = bytes.subarray(offset, offset + lengthNumber);
      offset += lengthNumber;
      callback({ field, wire, value: null, bytes: fieldBytes });
      continue;
    }

    if (wire === 3) {
      const groupEnd = skipGroup(bytes, offset, end, field, 0);
      if (groupEnd === null) return false;
      offset = groupEnd;
      callback({ field, wire, value: null, bytes: null });
      continue;
    }

    if (wire === 5) {
      const parsed = readFixed32(bytes, offset);
      if (!parsed) return false;
      offset = parsed.offset;
      callback({ field, wire, value: parsed.value, bytes: null });
      continue;
    }

    return false;
  }

  return true;
}

/**
 * Iterates a bounded protobuf wire-format message. Returns false for malformed
 * data instead of throwing, and true only after consuming the full message.
 */
export function forEachField(bytes, callback) {
  if (!(bytes instanceof Uint8Array) ||
      bytes.byteLength > MAX_MESSAGE_BYTES ||
      typeof callback !== "function") {
    return false;
  }

  try {
    return walk(bytes, callback, 0, bytes.length);
  } catch {
    return false;
  }
}
