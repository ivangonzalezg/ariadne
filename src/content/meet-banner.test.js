import { afterEach, describe, expect, it, vi } from "vitest";

function mockChrome() {
  globalThis.chrome = {
    runtime: { getURL: (path) => path },
    storage: {
      local: {
        get: (defaults, callback) => callback(defaults),
        set: () => {},
      },
    },
    tabs: { create: () => {} },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe("showBanner", () => {
  it("renders the detected-state copy, including a banner-specific key, once initI18n resolves", async () => {
    vi.resetModules();
    mockChrome();
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        "popup.statusDetected": "Meeting detected",
        "popup.startCapture": "Start capture",
        "banner.stopButton": "Stop",
      }),
    }));

    const { showBanner } = await import("./meet-banner.js");
    await showBanner({ onStart: () => {}, onStop: () => {} });

    const host = document.getElementById("asterion-banner-host");
    expect(host).not.toBeNull();
    const content = host.shadowRoot.getElementById("content").innerHTML;
    expect(content).toContain("Meeting detected");
    expect(content).toContain("Start capture");
  });

  it("renders in Spanish when the browser locale is es, including a banner-specific key", async () => {
    vi.resetModules();
    mockChrome();
    globalThis.fetch = vi.fn((url) => {
      const dict = String(url).includes("/es.json")
        ? { "popup.statusDetected": "Reunión detectada", "popup.startCapture": "Iniciar captura", "banner.stopButton": "Detener" }
        : { "popup.statusDetected": "Meeting detected", "popup.startCapture": "Start capture", "banner.stopButton": "Stop" };
      return Promise.resolve({ ok: true, status: 200, json: async () => dict });
    });
    const originalLanguage = navigator.language;
    Object.defineProperty(navigator, "language", { value: "es-AR", configurable: true });

    const { showBanner } = await import("./meet-banner.js");
    await showBanner({ onStart: () => {}, onStop: () => {} });

    const host = document.getElementById("asterion-banner-host");
    const content = host.shadowRoot.getElementById("content").innerHTML;
    expect(content).toContain("Reunión detectada");
    expect(content).toContain("Iniciar captura");

    Object.defineProperty(navigator, "language", { value: originalLanguage, configurable: true });
  });

  it("creates exactly one banner host when called twice before initI18n resolves", async () => {
    vi.resetModules();
    mockChrome();
    const fetchGate = deferred();
    globalThis.fetch = vi.fn(() => fetchGate.promise);

    const { showBanner } = await import("./meet-banner.js");
    const first = showBanner({ onStart: () => {}, onStop: () => {} });
    const second = showBanner({ onStart: () => {}, onStop: () => {} });

    fetchGate.resolve({
      ok: true,
      status: 200,
      json: async () => ({ "popup.statusDetected": "Meeting detected", "popup.startCapture": "Start capture" }),
    });
    await Promise.all([first, second]);

    expect(document.querySelectorAll("#asterion-banner-host").length).toBe(1);
  });
});
