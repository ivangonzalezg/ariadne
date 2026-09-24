import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaptionAssembler } from "./caption-assembler.js";

function caption(overrides = {}) {
  return {
    schema: "v2",
    captionId: 1,
    version: 1,
    text: "Hola",
    isFinal: false,
    deviceSpace: "device-a",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createCaptionAssembler", () => {
  it("finalizes v2 partial revisions once the final revision arrives", () => {
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ version: 1, text: "Hola" }), { receivedAtMs: 100 });
    assembler.onCaptionMessage(caption({ version: 2, text: "Hola mundo" }), { receivedAtMs: 250 });
    assembler.onCaptionMessage(caption({ version: 3, text: "Hola mundo final", isFinal: true }), { receivedAtMs: 400 });

    expect(onCaptionFinalized).toHaveBeenCalledTimes(1);
    expect(onCaptionFinalized).toHaveBeenCalledWith({
      captionId: 1,
      deviceSpace: "device-a",
      text: "Hola mundo final",
      startMs: 100,
      endMs: 400,
    });
  });

  it("finalizes v1 captions after their inactivity window", () => {
    vi.useFakeTimers();
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized, inactivityMs: 2000 });

    assembler.onCaptionMessage(caption({ schema: "v1", isFinal: null, text: "Sin final" }), { receivedAtMs: 100 });
    vi.advanceTimersByTime(1999);
    expect(onCaptionFinalized).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onCaptionFinalized).toHaveBeenCalledWith({
      captionId: 1,
      deviceSpace: "device-a",
      text: "Sin final",
      startMs: 100,
      endMs: 100,
    });
  });

  it("keeps interleaved captions from separate device spaces independent", () => {
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ captionId: 7, deviceSpace: "ana", text: "Ana parcial" }), { receivedAtMs: 10 });
    assembler.onCaptionMessage(caption({ captionId: 7, deviceSpace: "beto", text: "Beto parcial" }), { receivedAtMs: 20 });
    assembler.onCaptionMessage(caption({ captionId: 7, deviceSpace: "ana", version: 2, text: "Ana final", isFinal: true }), { receivedAtMs: 30 });
    assembler.onCaptionMessage(caption({ captionId: 7, deviceSpace: "beto", version: 2, text: "Beto final", isFinal: true }), { receivedAtMs: 40 });

    expect(onCaptionFinalized).toHaveBeenNthCalledWith(1, {
      captionId: 7, deviceSpace: "ana", text: "Ana final", startMs: 10, endMs: 30,
    });
    expect(onCaptionFinalized).toHaveBeenNthCalledWith(2, {
      captionId: 7, deviceSpace: "beto", text: "Beto final", startMs: 20, endMs: 40,
    });
  });

  it("discards a stale revision without changing the pending caption", () => {
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ version: 2, text: "Nueva" }), { receivedAtMs: 100 });
    assembler.onCaptionMessage(caption({ version: 1, text: "Vieja", isFinal: true }), { receivedAtMs: 200 });
    assembler.onCaptionMessage(caption({ version: 3, text: "Final", isFinal: true }), { receivedAtMs: 300 });

    expect(onCaptionFinalized).toHaveBeenCalledTimes(1);
    expect(onCaptionFinalized).toHaveBeenCalledWith({
      captionId: 1, deviceSpace: "device-a", text: "Final", startMs: 100, endMs: 300,
    });
  });

  it("compares Number and BigInt revisions without losing the newer revision", () => {
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ version: Number.MAX_SAFE_INTEGER, text: "Número" }), { receivedAtMs: 100 });
    assembler.onCaptionMessage(caption({ version: 9007199254740992n, text: "BigInt", isFinal: true }), { receivedAtMs: 200 });

    expect(onCaptionFinalized).toHaveBeenCalledWith({
      captionId: 1, deviceSpace: "device-a", text: "BigInt", startMs: 100, endMs: 200,
    });
  });

  it("flushes a pending v1 caption immediately", () => {
    vi.useFakeTimers();
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ schema: "v1", isFinal: null, text: "Pendiente" }), { receivedAtMs: 100 });
    assembler.flush();
    vi.advanceTimersByTime(2000);

    expect(onCaptionFinalized).toHaveBeenCalledTimes(1);
    expect(onCaptionFinalized).toHaveBeenCalledWith({
      captionId: 1, deviceSpace: "device-a", text: "Pendiente", startMs: 100, endMs: 100,
    });
  });

  it("reset clears pending state and cancels inactivity finalization", () => {
    vi.useFakeTimers();
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ schema: "v1", isFinal: null, text: "Sesión anterior" }), { receivedAtMs: 100 });
    assembler.reset();
    vi.advanceTimersByTime(2000);
    assembler.onCaptionMessage(caption({ text: "Sesión nueva", isFinal: true }), { receivedAtMs: 5000 });

    expect(onCaptionFinalized).toHaveBeenCalledTimes(1);
    expect(onCaptionFinalized).toHaveBeenCalledWith({
      captionId: 1, deviceSpace: "device-a", text: "Sesión nueva", startMs: 5000, endMs: 5000,
    });
  });

  it("starts an independent segment for a revision after finalization", () => {
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ text: "Primer final", isFinal: true }), { receivedAtMs: 100 });
    assembler.onCaptionMessage(caption({ version: 1, text: "Segundo final", isFinal: true }), { receivedAtMs: 200 });

    expect(onCaptionFinalized).toHaveBeenNthCalledWith(1, {
      captionId: 1, deviceSpace: "device-a", text: "Primer final", startMs: 100, endMs: 100,
    });
    expect(onCaptionFinalized).toHaveBeenNthCalledWith(2, {
      captionId: 1, deviceSpace: "device-a", text: "Segundo final", startMs: 200, endMs: 200,
    });
  });

  it("drops messages with nullish key parts to prevent fallback-key collisions", () => {
    const onCaptionFinalized = vi.fn();
    const assembler = createCaptionAssembler({ onCaptionFinalized });

    assembler.onCaptionMessage(caption({ captionId: null, isFinal: true }), { receivedAtMs: 100 });
    assembler.onCaptionMessage(caption({ deviceSpace: undefined, isFinal: true }), { receivedAtMs: 200 });

    expect(onCaptionFinalized).not.toHaveBeenCalled();
  });
});
