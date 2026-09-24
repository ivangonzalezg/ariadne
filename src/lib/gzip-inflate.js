const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Returns gzip payloads inflated with the browser-native Compression Streams API.
 * Non-gzip input is returned unchanged; malformed or oversized gzip data is null.
 */
export async function maybeGunzip(bytes) {
  const input = bytes instanceof Uint8Array
    ? bytes
    : bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : null;

  if (!input ||
      input.length < 3 ||
      input[0] !== 0x1f ||
      input[1] !== 0x8b ||
      input[2] !== 0x08) {
    return bytes;
  }

  try {
    const decompressed = new Response(input)
      .body
      .pipeThrough(new DecompressionStream("gzip"));
    const reader = decompressed.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_OUTPUT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch {
    return null;
  }
}
