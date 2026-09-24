import { describe, expect, it } from "vitest";
import { decodeCaptionV1, decodeCaptionV2 } from "./caption-protobuf-decoder.js";

const encoder = new TextEncoder();

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

function stringField(number, value) {
  const bytes = encoder.encode(value);
  return field(number, 2, [...varint(bytes.length), ...bytes]);
}

function messageField(number, value) {
  return field(number, 2, [...varint(value.length), ...value]);
}

function v1Caption({ deviceSpace = "device-1", captionId = 42, version = 3, text = "Hola", languageId = 7 } = {}) {
  const caption = [
    ...stringField(1, deviceSpace),
    ...field(2, 0, varint(captionId)),
    ...field(3, 0, varint(version)),
    ...stringField(6, text),
    ...field(8, 0, varint(languageId)),
  ];
  return new Uint8Array(messageField(1, caption));
}

function v2Caption({ isFinal, text = "Hola", captionId = 42, version = 3, deviceSpace = "device-1", timestampSeconds = 123 } = {}) {
  const body = [
    ...field(2, 0, varint(isFinal ? 1 : 0)),
    ...stringField(3, text),
    ...stringField(4, "es"),
    ...stringField(5, "en"),
    ...stringField(6, deviceSpace),
  ];
  const header = [
    ...field(1, 0, varint(captionId)),
    ...field(2, 0, varint(version)),
    ...messageField(3, body),
  ];
  const timestamp = field(1, 0, varint(timestampSeconds));
  return new Uint8Array([
    ...messageField(1, header),
    ...messageField(6, timestamp),
  ]);
}

describe("caption protobuf decoders", () => {
  it("decodes a simple v1 caption", () => {
    expect(decodeCaptionV1(v1Caption())).toEqual({
      schema: "v1",
      captionId: 42,
      version: 3,
      text: "Hola",
      isFinal: null,
      deviceSpace: "device-1",
      languageId: 7,
      timestampSeconds: null,
    });
  });

  it("applies protobuf defaults when optional v1 fields are omitted from the wire", () => {
    const caption = [
      ...stringField(6, "First revision"),
    ];

    expect(decodeCaptionV1(new Uint8Array(messageField(1, caption)))).toEqual({
      schema: "v1",
      captionId: 0,
      version: 0,
      text: "First revision",
      isFinal: null,
      deviceSpace: "",
      languageId: 0,
      timestampSeconds: null,
    });
  });

  it("returns null for a v1 caption without text", () => {
    const caption = [
      ...stringField(1, "device-1"),
    ];

    expect(decodeCaptionV1(new Uint8Array(messageField(1, caption)))).toBeNull();
  });

  it("discards a v1 caption when the wrapper unknown field is non-empty", () => {
    const caption = v1Caption();
    const unknown = stringField(2, "not a caption");

    expect(decodeCaptionV1(new Uint8Array([...caption, ...unknown]))).toBeNull();
  });

  it("decodes a final v2 caption", () => {
    expect(decodeCaptionV2(v2Caption({ isFinal: true }))).toEqual({
      schema: "v2",
      captionId: 42,
      version: 3,
      text: "Hola",
      isFinal: true,
      deviceSpace: "device-1",
      languageId: null,
      timestampSeconds: 123,
    });
  });

  it("decodes a non-final v2 caption", () => {
    expect(decodeCaptionV2(v2Caption({ isFinal: false }))).toMatchObject({
      schema: "v2",
      isFinal: false,
    });
  });

  it("applies protobuf defaults when optional v2 fields are omitted from the wire", () => {
    const body = [
      ...stringField(3, "Interim caption"),
    ];
    const header = [
      ...messageField(3, body),
    ];
    const timestamp = field(1, 0, varint(123));

    expect(decodeCaptionV2(new Uint8Array([
      ...messageField(1, header),
      ...messageField(6, timestamp),
    ]))).toEqual({
      schema: "v2",
      captionId: 0,
      version: 0,
      text: "Interim caption",
      isFinal: false,
      deviceSpace: "",
      languageId: null,
      timestampSeconds: 123,
    });
  });

  it("returns null for a v2 caption without text", () => {
    const body = [
      ...field(2, 0, varint(0)),
    ];
    const header = [
      ...messageField(3, body),
    ];
    const timestamp = field(1, 0, varint(123));

    expect(decodeCaptionV2(new Uint8Array([
      ...messageField(1, header),
      ...messageField(6, timestamp),
    ]))).toBeNull();
  });

  it("decodes UTF-8 text in a v2 caption", () => {
    expect(decodeCaptionV2(v2Caption({ isFinal: true, text: "¿Cómo estás, niño?" }))).toMatchObject({
      text: "¿Cómo estás, niño?",
    });
  });

  it("returns null for malformed or truncated v1 messages", () => {
    expect(decodeCaptionV1(new Uint8Array([0x0a, 0x05, 0x0a]))).toBeNull();
  });

  it("returns null for malformed or truncated v2 messages", () => {
    expect(decodeCaptionV2(new Uint8Array([0x0a, 0x05, 0x08]))).toBeNull();
  });
});
