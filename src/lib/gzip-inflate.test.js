import { describe, expect, it } from "vitest";
import { maybeGunzip } from "./gzip-inflate.js";

async function gzip(bytes) {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

describe("maybeGunzip", () => {
  it("returns non-gzip bytes unchanged", async () => {
    const bytes = new Uint8Array([0x08, 0x96, 0x01]);

    await expect(maybeGunzip(bytes)).resolves.toBe(bytes);
  });

  it("accepts an ArrayBuffer from a data channel", async () => {
    const original = new TextEncoder().encode("datos de caption");
    const compressed = await gzip(original);

    expect(Array.from(await maybeGunzip(compressed.buffer))).toEqual(Array.from(original));
  });

  it("inflates a valid synthetic gzip payload", async () => {
    const original = new TextEncoder().encode("Caption de prueba: ¡hola!");
    const compressed = await gzip(original);

    expect(Array.from(await maybeGunzip(compressed))).toEqual(Array.from(original));
  });

  it("returns null for corrupt or truncated gzip data", async () => {
    const compressed = await gzip(new TextEncoder().encode("payload"));
    const truncated = compressed.slice(0, compressed.length - 3);

    await expect(maybeGunzip(truncated)).resolves.toBeNull();
  });
});
