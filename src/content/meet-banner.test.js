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
  vi.useRealTimers();
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


it("shows transcription readiness independently of stored text", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mockChrome();
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({
    "common.transcript": "Transcripción",
    "popup.activeFem": "Activa",
    "common.notAvailable": "No disponible",
    "transcript.preparing": "Preparando",
    "transcript.paused": "Pausada por ti",
    "transcript.storageError": "Error al guardar",
  }) }));
  const { showBanner, updateBannerState } = await import("./meet-banner.js");
  await showBanner({ onStart: () => {}, onStop: () => {} });
  updateBannerState("recording", { startedAt: Date.now(), transcriptActive: true, hasTranscript: false });
  const root = document.getElementById("asterion-banner-host").shadowRoot;
  root.querySelector("#toggle-expanded").click();
  const transcriptRow = () => Array.from(root.querySelectorAll(".source-row"))
    .find(row => row.textContent.includes("Transcripción"));
  expect(transcriptRow().textContent).toContain("Activa");
  updateBannerState("recording", { transcriptActive: false, hasTranscript: true });
  expect(transcriptRow().textContent).toContain("Preparando");
  updateBannerState("recording", { captionState: "paused", transcriptActive: false });
  expect(transcriptRow().textContent).toContain("Pausada por ti");
  updateBannerState("recording", { captionStorage: { error: "disk" } });
  expect(transcriptRow().textContent).toContain("Error al guardar");
  updateBannerState("idle");
});

async function setupBanner() {
  vi.resetModules();
  vi.useFakeTimers();
  mockChrome();
  const dictionary = (await import("../shared/i18n/locales/en.json")).default;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => dictionary }));
  const api = await import("./meet-banner.js");
  const onStart = vi.fn();
  const onStop = vi.fn();
  await api.showBanner({ onStart, onStop });
  const root = document.getElementById("asterion-banner-host").shadowRoot;
  return { ...api, root, onStart, onStop };
}

describe("persistent capture widget", () => {
  it("locks start immediately and exposes recording controls only after confirmation", async () => {
    const { root, onStart, updateBannerState } = await setupBanner();
    const start = root.querySelector("#start-capture");
    const controls = root.querySelector(".controls");
    const originalLabel = start.textContent;
    const labelNode = root.querySelector(".start-label").firstChild;
    start.focus();
    start.click();
    start.click();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(start.disabled).toBe(true);
    expect(root.activeElement).toBe(root.querySelector(".meeting"));
    expect(start.getAttribute("aria-busy")).toBe("true");
    expect(start.textContent).toBe(originalLabel);
    expect(root.querySelector(".start-label").firstChild).toBe(labelNode);
    expect(controls.hasAttribute("inert")).toBe(true);
    expect(root.querySelector(".timer").getAttribute("aria-hidden")).toBe("true");
    updateBannerState("recording", { startedAt: Date.now() });
    expect(root.querySelector("#start-capture")).toBe(start);
    expect(start.textContent).toBe(originalLabel);
    expect(start.disabled).toBe(true);
    expect(start.getAttribute("aria-busy")).toBe("false");
    expect(root.querySelector(".start-label").firstChild).toBe(labelNode);
    expect(controls.hasAttribute("inert")).toBe(false);
    expect(root.querySelector(".start-controls").hasAttribute("inert")).toBe(true);
    expect(root.activeElement).toBe(root.querySelector("#stop-capture"));
    expect(root.querySelector("#toggle-expanded").getAttribute("aria-expanded")).toBe("false");
    updateBannerState("idle");
    expect(start.disabled).toBe(false);
    expect(root.activeElement).toBe(start);
  });

  it("preserves nodes, focus, expansion and one timer across metadata updates", async () => {
    const { root, onStop, updateBannerState } = await setupBanner();
    const interval = vi.spyOn(globalThis, "setInterval");
    const startedAt = Date.now();
    updateBannerState("recording", { startedAt, transcriptActive: true });
    const toggle = root.querySelector("#toggle-expanded");
    const timer = root.querySelector(".timer");
    const video = root.querySelector(".video-button");
    const rows = [...root.querySelectorAll(".source-row")];
    toggle.click();
    toggle.focus();
    vi.advanceTimersByTime(2100);
    expect(timer.textContent).toBe("00:02");
    for (let i = 0; i < 5; i++) updateBannerState("recording", { micMuted: Boolean(i % 2) });
    updateBannerState("video-enabled", { videoEnabled: true });
    expect(root.querySelector("#toggle-expanded")).toBe(toggle);
    expect(root.activeElement).toBe(toggle);
    expect([...root.querySelectorAll(".source-row")]).toEqual(rows);
    expect(root.querySelector(".timer")).toBe(timer);
    expect(root.querySelector(".video-button")).toBe(video);
    expect(video.classList.contains("is-active")).toBe(true);
    expect(video.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(interval).toHaveBeenCalledTimes(1);
    root.querySelector("#stop-capture").click();
    expect(onStop).toHaveBeenCalledTimes(1);
    updateBannerState("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reverses details without replacing the panel or its chevron", async () => {
    const { root, updateBannerState } = await setupBanner();
    updateBannerState("recording", { startedAt: Date.now() });
    const panel = root.querySelector(".details");
    const toggle = root.querySelector("#toggle-expanded");
    const chevron = toggle.querySelector("svg");
    for (let i = 0; i < 3; i++) {
      toggle.click();
      expect(panel.hasAttribute("inert")).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      toggle.click();
      expect(panel.hasAttribute("inert")).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
    expect(root.querySelector(".details")).toBe(panel);
    expect(toggle.querySelector("svg")).toBe(chevron);
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    updateBannerState("idle");
  });

  it("stops the timer in error and finished states and keeps their actions working", async () => {
    const { root, updateBannerState, showFinishedBanner } = await setupBanner();
    const tabs = vi.spyOn(chrome.tabs, "create");
    updateBannerState("recording", { startedAt: Date.now() });
    root.querySelector("#stop-capture").focus();
    updateBannerState("error");
    expect(root.querySelector(".meeting").hidden).toBe(true);
    expect(root.querySelector(".error-banner").hidden).toBe(false);
    expect(root.activeElement).toBe(root.querySelector(".error-banner"));
    expect(vi.getTimerCount()).toBe(0);
    updateBannerState("recording", { startedAt: Date.now() });
    root.querySelector("#stop-capture").focus();
    showFinishedBanner();
    expect(root.querySelector(".finished").hidden).toBe(false);
    expect(root.activeElement).toBe(root.querySelector("#view-recording"));
    expect(vi.getTimerCount()).toBe(0);
    root.querySelector("#view-recording").click();
    expect(tabs).toHaveBeenCalledWith({ url: "src/history/history.html" });
    root.querySelector("#dismiss-banner").click();
    expect(root.querySelector("#content").hidden).toBe(true);
  });

  it("formats hours without creating a second interval", async () => {
    const { root, updateBannerState } = await setupBanner();
    updateBannerState("recording", { startedAt: Date.now() - 3599000 });
    expect(root.querySelector(".timer").textContent).toBe("59:59");
    vi.advanceTimersByTime(1000);
    expect(root.querySelector(".timer").textContent).toBe("01:00:00");
    updateBannerState("idle");
  });
});
