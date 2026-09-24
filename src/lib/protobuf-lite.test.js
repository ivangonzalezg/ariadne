import { describe, expect, it } from "vitest";
import { forEachField } from "./protobuf-lite.js";

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return bytes;
}

function field(number, wire, payload) {
  return [...varint((number << 3) | wire), ...payload];
}

describe("forEachField", () => {
  it("walks varint, fixed-width, and length-delimited fields", () => {
    const message = new Uint8Array([
      ...field(1, 0, varint(150)),
      ...field(2, 2, [...varint(2), 0x68, 0x69]),
      ...field(3, 1, [1, 0, 0, 0, 0, 0, 0, 0]),
      ...field(4, 5, [0x78, 0x56, 0x34, 0x12]),
    ]);
    const fields = [];

    expect(forEachField(message, (entry) => fields.push(entry))).toBe(true);
    expect(fields).toEqual([
      { field: 1, wire: 0, value: 150, bytes: null },
      { field: 2, wire: 2, value: null, bytes: new Uint8Array([0x68, 0x69]) },
      { field: 3, wire: 1, value: 1, bytes: null },
      { field: 4, wire: 5, value: 0x12345678, bytes: null },
    ]);
  });

  it("skips interleaved fields that a consumer does not recognize", () => {
    const message = new Uint8Array([
      ...field(1, 0, varint(7)),
      ...field(99, 2, [...varint(3), 0xaa, 0xbb, 0xcc]),
      ...field(2, 0, varint(9)),
    ]);
    const recognized = [];

    expect(forEachField(message, ({ field: number, value }) => {
      if (number === 1 || number === 2) recognized.push(value);
    })).toBe(true);
    expect(recognized).toEqual([7, 9]);
  });

  it("uses BigInt for varints beyond Number.MAX_SAFE_INTEGER", () => {
    const value = BigInt(Number.MAX_SAFE_INTEGER) + 42n;
    const fields = [];

    expect(forEachField(new Uint8Array(field(2, 0, varint(value))), (entry) => fields.push(entry))).toBe(true);
    expect(fields[0].value).toBe(value);
    expect(typeof fields[0].value).toBe("bigint");
  });

  it("fails cleanly for a truncated field without invoking the callback", () => {
    const callback = () => {
      throw new Error("must not be called");
    };

    expect(forEachField(new Uint8Array([0x12, 0x05, 0x68]), callback)).toBe(false);
  });

  it("fails cleanly when a varint never terminates", () => {
    expect(forEachField(new Uint8Array([0x08, ...Array(10).fill(0x80)]), () => {})).toBe(false);
  });
});
