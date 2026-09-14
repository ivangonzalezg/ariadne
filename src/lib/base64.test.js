import { describe, expect, it } from "vitest";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";

describe("base64 ArrayBuffer round-trip", () => {
  it("round-trips arbitrary bytes, including edge values", () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255, 128, 65]);
    const base64 = arrayBufferToBase64(original.buffer);
    const decoded = new Uint8Array(base64ToArrayBuffer(base64));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("round-trips an empty buffer", () => {
    const original = new Uint8Array([]);
    const base64 = arrayBufferToBase64(original.buffer);
    const decoded = new Uint8Array(base64ToArrayBuffer(base64));
    expect(decoded.length).toBe(0);
  });

  it("round-trips a larger buffer of random-ish bytes", () => {
    const original = new Uint8Array(5000);
    for (let i = 0; i < original.length; i++) original[i] = (i * 37) % 256;
    const base64 = arrayBufferToBase64(original.buffer);
    const decoded = new Uint8Array(base64ToArrayBuffer(base64));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});
