// src/shared/debug-log.test.js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugDebug, debugLog, isDebugEnabled, setDebugEnabled } from "./debug-log.js";

describe("debug-log", () => {
  let logSpy;
  let debugSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    setDebugEnabled(false);
  });

  afterEach(() => {
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("is disabled by default", () => {
    expect(isDebugEnabled()).toBe(false);
  });

  it("does not call console.log when disabled", () => {
    debugLog("[Ariadne:debug] hola", { a: 1 });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("calls console.log with the same arguments when enabled", () => {
    setDebugEnabled(true);
    debugLog("[Ariadne:debug] hola", { a: 1 });
    expect(logSpy).toHaveBeenCalledWith("[Ariadne:debug] hola", { a: 1 });
  });

  it("isDebugEnabled reflects the last value set", () => {
    setDebugEnabled(true);
    expect(isDebugEnabled()).toBe(true);
    setDebugEnabled(false);
    expect(isDebugEnabled()).toBe(false);
  });

  it("coerces a truthy/falsy non-boolean value passed to setDebugEnabled", () => {
    setDebugEnabled(1);
    expect(isDebugEnabled()).toBe(true);
    setDebugEnabled(undefined);
    expect(isDebugEnabled()).toBe(false);
  });

  it("debugDebug does not call console.debug when disabled", () => {
    debugDebug("[Ariadne:rtc-patch] evento", { a: 1 });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("debugDebug calls console.debug with the same arguments when enabled", () => {
    setDebugEnabled(true);
    debugDebug("[Ariadne:rtc-patch] evento", { a: 1 });
    expect(debugSpy).toHaveBeenCalledWith("[Ariadne:rtc-patch] evento", { a: 1 });
  });
});

describe("exportable diagnostic events", () => {
  it("serializes a snapshot at log time instead of exporting only Object", async () => {
    const { debugEvent } = await import("./debug-log.js");
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      setDebugEnabled(true);
      const details = { tracks: [{ rms: 0.25, enabled: true }] };
      debugEvent("audio-flow", details);
      details.tracks[0].rms = 0;
      const text = spy.mock.calls[0][0];
      expect(text).toContain('"rms":0.25');
      expect(JSON.parse(text.slice("[Ariadne:event] ".length))).toMatchObject({ event: "audio-flow", details: { tracks: [{ rms: 0.25 }] } });
      const cyclic = {}; cyclic.self = cyclic;
      expect(() => debugEvent("cyclic", cyclic)).not.toThrow();
      expect(spy.mock.calls[1][0]).toContain('"serializationError":true');
      setDebugEnabled(false);
      debugEvent("disabled", details);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { setDebugEnabled(false); spy.mockRestore(); }
  });
});
