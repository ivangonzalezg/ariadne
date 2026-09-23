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
