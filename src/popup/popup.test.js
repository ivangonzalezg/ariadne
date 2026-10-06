import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../shared/i18n/locales/en.json";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(initial = {}, { failInitial = false } = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="app" tabindex="-1"></div>';
  let status = { inMeeting: true, state: "idle", meetingTitle: "Team sync", ...initial };
  let autoStart = false;
  let conversion = { count: 0, entries: [] };
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => en }));
  globalThis.chrome = {
    runtime: {
      getURL: path => path,
      sendMessage: vi.fn(async () => conversion),
    },
    storage: { local: {
      get: vi.fn(async () => { if (failInitial) throw Error("Unavailable"); return { autoStart }; }),
      set: vi.fn(async data => { autoStart = data.autoStart; }),
    } },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://meet.google.com/abc" }]),
      sendMessage: vi.fn(async (_tab, message) => message.type === "asterion:get-status" ? status : { ok: true }),
      create: vi.fn(),
    },
  };
  const api = await import("./popup.js");
  return {
    ...api,
    setStatus: next => { status = { ...status, ...next }; },
    setConversion: next => { conversion = next; },
    getAutoStart: () => autoStart,
    app: document.getElementById("app"),
    start: document.getElementById("start-capture"),
    stop: document.getElementById("stop-capture"),
    toggle: document.getElementById("auto-start-toggle"),
  };
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe("popup capture states", () => {
  it("keeps start text and nodes while awaiting real recording confirmation", async () => {
    const ui = await setup();
    const text = ui.start.textContent;
    ui.start.focus();
    ui.start.click(); ui.start.click();
    await settle();
    expect(chrome.tabs.sendMessage.mock.calls.filter(([, m]) => m.type === "asterion:popup-start")).toHaveLength(1);
    expect(ui.start.disabled).toBe(true);
    expect(ui.start.getAttribute("aria-busy")).toBe("true");
    expect(ui.start.textContent).toBe(text);
    expect(ui.app.dataset.recording).toBe("false");
    expect(ui.stop.closest("[inert]")).toBeTruthy();
    ui.setStatus({ state: "starting" }); await ui.refresh();
    expect(ui.start.disabled).toBe(true);
    expect(ui.app.dataset.recording).toBe("false");
    ui.setStatus({ state: "recording", startedAt: Date.now() }); await ui.refresh();
    expect(document.getElementById("start-capture")).toBe(ui.start);
    expect(document.getElementById("stop-capture")).toBe(ui.stop);
    expect(ui.start.textContent).toBe(text);
    expect(ui.app.dataset.recording).toBe("true");
    expect(document.activeElement).toBe(ui.stop);
    expect(ui.stop.closest("[inert]")).toBeNull();
  });

  it("blocks duplicate stop requests until the session leaves recording", async () => {
    const ui = await setup({ state: "recording", startedAt: Date.now() });
    ui.stop.focus(); ui.stop.click(); ui.stop.click();
    await settle();
    expect(chrome.tabs.sendMessage.mock.calls.filter(([, m]) => m.type === "asterion:popup-stop")).toHaveLength(1);
    expect(ui.stop.disabled).toBe(true);
    expect(ui.stop.textContent).toContain("Stop capture");
    ui.setStatus({ state: "idle" }); await ui.refresh();
    expect(ui.start.disabled).toBe(false);
    expect(document.activeElement).toBe(ui.start);
  });

  it("releases pending actions and shows inline errors on transport failure", async () => {
    const ui = await setup();
    chrome.tabs.sendMessage.mockImplementation(async (_tab, m) => {
      if (m.type === "asterion:popup-start") throw new Error("Disconnected");
      return { inMeeting: true, state: "idle" };
    });
    ui.start.click(); await settle();
    expect(ui.start.disabled).toBe(false);
    expect(ui.app.querySelector(".action-error").hidden).toBe(false);
    expect(ui.start.getAttribute("aria-busy")).toBe("false");
  });

  it("does not present starting or unknown states as recording", async () => {
    const ui = await setup({ state: "starting" });
    expect(ui.app.dataset.recording).toBe("false");
    expect(ui.start.disabled).toBe(true);
    ui.setStatus({ state: "error" }); await ui.refresh();
    expect(ui.app.querySelector(".status-title").textContent).toBe("Error");
    expect(ui.app.querySelector(".capture-actions").hidden).toBe(true);
    ui.setStatus({ state: "unrecognized" }); await ui.refresh();
    expect(ui.app.dataset.recording).toBe("false");
  });

  it("serializes polling and discards a pre-action response", async () => {
    const ui = await setup();
    const gate = deferred();
    let reads = 0;
    chrome.tabs.sendMessage.mockImplementation(async (_tab, m) => {
      if (m.type !== "asterion:get-status") return { ok: true };
      reads++;
      return reads === 1 ? gate.promise : { inMeeting: true, state: "idle" };
    });
    const refresh = ui.refresh(); await settle();
    ui.refresh(); ui.refresh();
    expect(reads).toBe(1);
    ui.start.click(); await settle();
    gate.resolve({ inMeeting: true, state: "idle", meetingTitle: "STALE" });
    await refresh;
    expect(ui.start.disabled).toBe(true);
    expect(ui.app.querySelector(".meeting-name").textContent).not.toBe("STALE");
    expect(reads).toBe(2);
  });

  it("ignores failed stale queries instead of unlocking a newer start action", async () => {
    const ui = await setup();
    const gate = deferred();
    let reads = 0;
    chrome.tabs.sendMessage.mockImplementation(async (_tab, message) => {
      if (message.type !== "asterion:get-status") return { ok: true };
      return ++reads === 1 ? gate.promise : { inMeeting: true, state: "idle" };
    });
    const running = ui.refresh(); await settle();
    ui.start.click(); await settle();
    gate.reject(Error("Old request failed")); await running;
    expect(ui.start.disabled).toBe(true);
    expect(ui.app.querySelector(".action-error").hidden).toBe(true);
  });

  it("does not apply an old response after a pending action fails", async () => {
    const ui = await setup();
    const gate = deferred();
    chrome.tabs.sendMessage.mockImplementation(async (_tab, m) => {
      if (m.type === "asterion:popup-start") throw Error("Disconnected");
      return gate.promise;
    });
    const running = ui.refresh(); await settle();
    ui.start.click(); await settle();
    expect(ui.start.disabled).toBe(false);
    gate.resolve({ inMeeting: true, state: "idle" }); await running;
    expect(ui.app.querySelector(".action-error").hidden).toBe(false);
  });
});

describe("persistent popup updates", () => {
  it("keeps focused controls and one timer through service updates", async () => {
    const ui = await setup({ state: "recording", startedAt: Date.now() - 3599000 });
    const clear = vi.spyOn(globalThis, "clearInterval");
    const timer = document.getElementById("timer");
    const rows = [...ui.app.querySelectorAll(".source-row")];
    const titleText = ui.app.querySelector(".status-title").firstChild;
    ui.stop.focus();
    expect(timer.textContent).toBe("59:59");
    await vi.advanceTimersByTimeAsync(1000);
    expect(timer.textContent).toBe("01:00:00");
    for (let i = 0; i < 3; i++) await ui.refresh();
    ui.setStatus({ state: "video-enabled", videoEnabled: true, captionState: "paused" }); await ui.refresh();
    expect([...ui.app.querySelectorAll(".source-row")]).toEqual(rows);
    expect(document.getElementById("timer")).toBe(timer);
    expect(ui.app.querySelector(".status-title").firstChild).toBe(titleText);
    expect(document.activeElement).toBe(ui.stop);
    expect(ui.app.querySelector('[data-source="video"] .source-status').classList.contains("is-active")).toBe(true);
    expect(ui.app.querySelector('[data-source="transcript"] .source-value').textContent).toBe(en["transcript.paused"]);
    expect(vi.getTimerCount()).toBe(2);
    ui.setStatus({ state: "idle" }); await ui.refresh();
    expect(clear).toHaveBeenCalledTimes(1);
    const stoppedTime = timer.textContent;
    await vi.advanceTimersByTimeAsync(1000);
    expect(timer.textContent).toBe(stoppedTime);
  });

  it("shows zero for invalid dates and escapes meeting titles", async () => {
    const ui = await setup({ state: "recording", startedAt: null, meetingTitle: '<img src=x onerror="alert(1)">' });
    expect(document.getElementById("timer").textContent).toBe("00:00");
    expect(ui.app.querySelector(".meeting-name img")).toBeNull();
    ui.setStatus({ startedAt: Date.now() + 60000 }); await ui.refresh();
    expect(document.getElementById("timer").textContent).toBe("00:00");
  });

  it("updates conversion progress in place and removes it accessibly", async () => {
    const ui = await setup({ inMeeting: false });
    const label = ui.app.querySelector(".conversion-label");
    const region = ui.app.querySelector(".conversion-region");
    ui.setConversion({ count: 1, entries: [{ stream: "video", pct: 22 }] }); await ui.refresh();
    expect(label.textContent).toContain("22%");
    expect(region.dataset.open).toBe("true");
    ui.setConversion({ count: 1, entries: [{ stream: "video", pct: 71 }] }); await ui.refresh();
    expect(ui.app.querySelector(".conversion-label")).toBe(label);
    expect(label.textContent).toContain("71%");
    ui.setConversion({ count: 0, entries: [] }); await ui.refresh();
    expect(region.hasAttribute("inert")).toBe(true);
    expect(region.dataset.open).toBe("false");
    expect(label.textContent).toContain("71%");
  });

  it("switches preferences optimistically and restores focus", async () => {
    const ui = await setup();
    const gate = deferred();
    chrome.storage.local.set.mockImplementation(() => gate.promise);
    ui.toggle.focus(); ui.toggle.click(); ui.toggle.click();
    expect(ui.toggle.getAttribute("aria-checked")).toBe("true");
    expect(ui.toggle.disabled).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    gate.resolve(); await settle();
    // The mock write did not persist, so polling correctly restores its stored value.
    expect(ui.toggle.disabled).toBe(false);
    expect(document.activeElement).toBe(ui.toggle);
  });

  it("persists a successful preference change without reverting on refresh", async () => {
    const ui = await setup();
    ui.toggle.focus(); ui.toggle.click(); await settle();
    await ui.refresh();
    expect(ui.getAutoStart()).toBe(true);
    expect(ui.toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(ui.toggle);
  });

  it("rolls a failed preference write back and shows the error", async () => {
    const ui = await setup();
    chrome.storage.local.set.mockRejectedValue(Error("Write failed"));
    ui.toggle.click(); await settle();
    expect(ui.toggle.getAttribute("aria-checked")).toBe("false");
    expect(ui.toggle.disabled).toBe(false);
    expect(ui.app.querySelector(".action-error").hidden).toBe(false);
  });

  it("uses native buttons for settings and history and preserves destinations", async () => {
    const ui = await setup();
    expect(ui.toggle.tagName).toBe("BUTTON");
    expect(ui.toggle.getAttribute("role")).toBe("switch");
    for (const path of ["history", "settings"]) {
      const button = document.getElementById(`${path}-link`);
      expect(button.tagName).toBe("BUTTON"); button.click();
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `src/${path}/${path}.html` });
    }
  });

  it("shows a usable popup if the initial query fails", async () => {
    const ui = await setup({}, { failInitial: true });
    expect(ui.app.hasAttribute("data-ready")).toBe(true);
    expect(ui.app.querySelector(".action-error").hidden).toBe(false);
  });
});
