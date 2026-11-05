import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./meet-mute-observer.js", () => ({ observeMuteState: vi.fn(callback => { callback(true, Date.now()); return vi.fn(); }) }));
vi.mock("./meet-caption-observer.js", () => ({ enableCaptionsAndObserve: vi.fn(() => vi.fn()) }));
vi.mock("./meet-local-identity.js", () => ({ observeLocalIdentity: vi.fn(() => vi.fn()) }));
vi.mock("./meet-banner.js", () => ({ showBanner: vi.fn(async () => {}), updateBannerState: vi.fn() }));
vi.mock("./chunk-delivery.js", () => ({ ChunkDelivery: class {
  pending = new Map(); bytes = 0; recoveries = 0;
  constructor(options) { Object.assign(this, options); }
  flush = vi.fn(async () => []);
} }));
vi.mock("./caption-delivery.js", () => ({ CaptionDelivery: class {
  pending = new Map(); eventSeq = 0;
  flush = vi.fn(async () => []); dispose = vi.fn();
} }));
vi.mock("./caption-router.js", () => ({ CaptionRouter: class { setLocalIdentity() {} } }));

const listeners = [];
let presenceStop;
vi.mock("./meeting-presence.js", async importOriginal => {
  const original = await importOriginal();
  return { ...original, observeMeetingPresence(callback, options) {
    presenceStop = original.observeMeetingPresence(callback, options);
    return presenceStop;
  } };
});

const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let runtimeListeners, storageChanged, post, banner;
async function setup({ autoStart = false, opening, captionPreferences, autoPreferences, minimumDurationSeconds = 0, storageStartOffsetMs = 0, finalization } = {}) {
  vi.resetModules(); vi.useFakeTimers();
  document.body.innerHTML = '<button id="leave"><i>call_end</i></button>';
  runtimeListeners = [];
  globalThis.chrome = {
    storage: { local: { get: vi.fn(async defaults => {
      if ("autoStart" in defaults) return autoPreferences ? autoPreferences.promise : { autoStart };
      if ("captionMode" in defaults && captionPreferences) return captionPreferences.promise;
      return defaults;
    }) }, onChanged: { addListener: callback => { storageChanged = callback; } } },
    runtime: { onMessage: { addListener: callback => runtimeListeners.push(callback) }, sendMessage: vi.fn(async message => {
      if (message.type === "asterion:session-starting") return opening ? opening.promise : { folderName: "folder", startedAt: Date.now() + storageStartOffsetMs, minimumMeetingDurationSeconds: minimumDurationSeconds };
      if (message.type === "asterion:session-ended") return finalization ? finalization.promise : { sessionId: message.sessionId, folderName: "folder", processing: { revision: 1, pending: true } };
      return {};
    }) },
  };
  const addListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, callback, options) => {
    listeners.push([type, callback]); addListener(type, callback, options);
  });
  post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  banner = await import("./meet-banner.js");
  await import("./meet-detector.js");
  await flush();
}
function request(type) {
  return new Promise(resolve => { for (const listener of runtimeListeners) listener({ type }, {}, resolve); });
}
function emit(type, fields = {}) {
  window.dispatchEvent(new MessageEvent("message", { source: window, data: { source: "asterion-main-world", type, ...fields } }));
}
function lastBanner() { return banner.updateBannerState.mock.calls.at(-1); }
function leave() { document.getElementById("leave").hidden = true; }
async function confirmExit() { leave(); await flush(); await vi.advanceTimersByTimeAsync(3000); }
function rejoin() { document.getElementById("leave").hidden = false; }
async function start() {
  expect(await request("asterion:popup-start")).toEqual({ ok: true });
  const status = await request("asterion:get-status");
  emit("asterion:session-started", { sessionId: status.sessionId });
  return status.sessionId;
}
function published(sessionId, metadata = {}) {
  storageChanged({ meetingHistory: { newValue: [{ sessionId, ...metadata }] } }, "local");
}
afterEach(() => {
  presenceStop?.();
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); delete globalThis.chrome;
});

describe("meeting capture lifecycle", () => {
  it.each([true, false])("preserves the session and enabled video through modals and brief absences with autoStart=%s", async autoStart => {
    await setup({ autoStart });
    const sessionId = autoStart ? (await request("asterion:get-status")).sessionId : await start();
    emit("asterion:session-started", { sessionId });
    emit("asterion:video-enabled", { sessionId });
    const button = document.getElementById("leave");
    for (let repeat = 0; repeat < 2; repeat++) {
      button.setAttribute("aria-hidden", "true"); button.setAttribute("inert", "");
      await flush(); await vi.advanceTimersByTimeAsync(10000);
      expect(await request("asterion:get-status")).toMatchObject({ sessionId, inMeeting: true, state: "video-enabled", videoEnabled: true });
      button.removeAttribute("aria-hidden"); button.removeAttribute("inert"); await flush();
      leave(); await flush(); await vi.advanceTimersByTimeAsync(2999);
      rejoin(); await flush(); await vi.advanceTimersByTimeAsync(3000);
    }
    expect((await request("asterion:get-status")).sessionId).toBe(sessionId);
    expect(post.mock.calls.filter(([m]) => m.type === "asterion:stop-session")).toHaveLength(0);
    expect(chrome.runtime.sendMessage.mock.calls.filter(([m]) => m.type === "asterion:session-starting")).toHaveLength(1);
  });

  it.each(["manual", "pagehide"])("stops immediately on %s during a pending exit, without a duplicate stop", async reason => {
    await setup(); await start(); leave(); await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(post.mock.calls.filter(([m]) => m.type === "asterion:stop-session")).toHaveLength(0);
    if (reason === "manual") await request("asterion:popup-stop");
    else window.dispatchEvent(new Event("pagehide"));
    expect(post.mock.calls.filter(([m]) => m.type === "asterion:stop-session")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(post.mock.calls.filter(([m]) => m.type === "asterion:stop-session")).toHaveLength(1);
  });

  it("hides after exit without capture and rejects late popup and banner starts", async () => {
    await setup(); await confirmExit();
    expect(lastBanner()[1].visible).toBe(false);
    expect(await request("asterion:popup-start")).toMatchObject({ ok: false });
    await banner.showBanner.mock.calls.at(-1)[0].onStart(); await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(await request("asterion:get-status")).toMatchObject({ inMeeting: false, sessionId: null });
    rejoin(); await flush(); expect(lastBanner()).toMatchObject(["idle", { visible: true }]);
  });

  it("stops once on exit and keeps a notice through saving, processing and completion", async () => {
    await setup(); const sessionId = await start();
    await confirmExit();
    expect(lastBanner()).toMatchObject(["saving", { visible: true, captureSessionId: sessionId }]);
    await request("asterion:popup-stop");
    expect(post.mock.calls.filter(([m]) => m.type === "asterion:stop-session")).toHaveLength(1);
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    expect(lastBanner()[0]).toBe("processing");
    published(sessionId, { processing: { revision: 2, pending: false } });
    expect(lastBanner()[0]).toBe("finished");
    published("unrelated", { error: "failed" }); expect(lastBanner()[0]).toBe("finished");
  });

  it("hides a manual-stop notice on exit and never resurrects it", async () => {
    await setup(); const sessionId = await start(); await request("asterion:popup-stop");
    expect(lastBanner()[0]).toBe("saving"); await confirmExit();
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    published(sessionId, { processing: { revision: 3, pending: false } });
    expect(lastBanner()[1].visible).toBe(false);
  });

  it("keeps a dismissed notice dismissed, and permits a later manual capture", async () => {
    await setup(); const sessionId = await start(); await request("asterion:popup-stop");
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    banner.showBanner.mock.calls.at(-1)[0].onDismiss(sessionId);
    published(sessionId, { processing: { revision: 2, pending: false } });
    expect(lastBanner()).toMatchObject(["idle", { visible: true, captureSessionId: null }]);
    expect(await start()).not.toBe(sessionId);
  });

  it.each(["manual", "meeting-left"])("never flashes saving for a short capture stopped by %s", async reason => {
    const finalization = deferred();
    await setup({ minimumDurationSeconds: 10, finalization });
    const sessionId = await start();
    vi.advanceTimersByTime(reason === "manual" ? 9999 : 6999);
    banner.updateBannerState.mockClear();
    if (reason === "manual") await request("asterion:popup-stop");
    else { await confirmExit(); }
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    expect(banner.updateBannerState.mock.calls.some(([state]) => state === "saving")).toBe(false);
    finalization.resolve({ sessionId, discarded: true }); await flush();
    expect(banner.updateBannerState.mock.calls.some(([state]) => state === "saving")).toBe(false);
    expect(lastBanner()).toMatchObject(["idle", { visible: reason === "manual", captureSessionId: null }]);
  });

  it.each([10000, 10001])("keeps the saving notice when capture duration is %s ms at a 10 second minimum", async duration => {
    await setup({ minimumDurationSeconds: 10 }); await start();
    vi.advanceTimersByTime(duration); await request("asterion:popup-stop");
    expect(lastBanner()[0]).toBe("saving");
  });

  it("uses the storage start time when it differs from the UI timer", async () => {
    await setup({ minimumDurationSeconds: 10, storageStartOffsetMs: 500 }); await start();
    vi.advanceTimersByTime(10000); banner.updateBannerState.mockClear();
    await request("asterion:popup-stop");
    expect(banner.updateBannerState.mock.calls.some(([state]) => state === "saving")).toBe(false);
  });

  it("also suppresses saving when the recorder ends a short capture without a stop click", async () => {
    await setup({ minimumDurationSeconds: 10 }); const sessionId = await start();
    vi.advanceTimersByTime(1000); banner.updateBannerState.mockClear();
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    expect(banner.updateBannerState.mock.calls.some(([state]) => state === "saving")).toBe(false);
  });

  it("reports failed processing and removes discarded captures", async () => {
    await setup(); const sessionId = await start(); await request("asterion:popup-stop");
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    published(sessionId, { processing: { revision: 2, pending: false, canRetry: true } });
    expect(lastBanner()[0]).toBe("capture-error");
    published(sessionId, { discarded: true }); expect(lastBanner()[1].captureSessionId).toBeNull();
  });

  it.each([true, false])("respects autoStart=%s on reentry while the previous capture stops", async autoStart => {
    await setup({ autoStart });
    const sessionId = autoStart ? (await request("asterion:get-status")).sessionId : await start();
    await confirmExit(); rejoin(); await flush();
    expect(lastBanner()[1].captureSessionId).toBeNull();
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    const status = await request("asterion:get-status");
    if (autoStart) expect(status.sessionId).toBeTruthy(); else expect(status.sessionId).toBeNull();
    published(sessionId, { error: "Old capture failed" });
    expect(lastBanner()[1].captureSessionId).toBeNull();
  });

  it("cancels while reading preferences without opening storage or starting media", async () => {
    const captionPreferences = deferred(); await setup({ captionPreferences });
    const starting = request("asterion:popup-start"); await flush(); await confirmExit();
    captionPreferences.resolve({ captionMode: "dom" });
    expect(await starting).toMatchObject({ ok: false });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(lastBanner()[1].visible).toBe(false);
  });

  it("finalizes storage opened after exit without starting media", async () => {
    const opening = deferred(); await setup({ opening });
    const starting = request("asterion:popup-start"); await flush(); await confirmExit();
    opening.resolve({ folderName: "folder" }); expect(await starting).toMatchObject({ ok: false });
    expect(chrome.runtime.sendMessage.mock.calls.map(([m]) => m.type)).toEqual(["asterion:session-starting", "asterion:session-ended"]);
    expect(post).not.toHaveBeenCalled();
    expect((await request("asterion:get-status")).sessionId).toBeNull();
    expect(lastBanner()[1].visible).toBe(false);
  });

  it("does not start another capture when initial autoStart preferences arrive after a manual capture", async () => {
    const autoPreferences = deferred(); await setup({ autoPreferences });
    const sessionId = await start(); await request("asterion:popup-stop");
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    autoPreferences.resolve({ autoStart: true }); await flush();
    expect((await request("asterion:get-status")).sessionId).toBeNull();
    expect(chrome.runtime.sendMessage.mock.calls.filter(([m]) => m.type === "asterion:session-starting")).toHaveLength(1);
  });

  it("ignores obsolete processing revisions and does not regress completion at the same revision", async () => {
    await setup(); const sessionId = await start(); await request("asterion:popup-stop");
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    published(sessionId, { processing: { revision: 3, pending: false } });
    published(sessionId, { processing: { revision: 2, pending: true } });
    published(sessionId, { processing: { revision: 3, pending: true } });
    expect(lastBanner()[0]).toBe("finished");
  });

  it("restores the start button on reentry after a failed capture start", async () => {
    await setup(); const sessionId = await start();
    emit("asterion:start-failed", { sessionId, reason: "Capture could not start" }); await flush();
    await confirmExit(); rejoin(); await flush();
    expect(lastBanner()).toMatchObject(["idle", { visible: true }]);
  });
});
