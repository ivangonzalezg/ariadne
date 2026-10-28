import { afterEach, describe, expect, it, vi } from "vitest";

const platformState = vi.hoisted(() => ({ id: "meet", onCaption: null }));
vi.mock("./meeting-platform.js", () => ({ getMeetingPlatform: () => ({
  id: platformState.id,
  isInActiveMeeting: () => true,
  getTitle: () => "Meeting",
  captionMode: () => "dom",
  observeMuteState: callback => { callback(true, Date.now()); return () => {}; },
  observeLocalIdentity: () => () => {},
  observeCaptions: callback => { platformState.onCaption = callback; return () => {}; },
}) }));
vi.mock("./meet-banner.js", () => ({ showBanner: vi.fn(), showFinishedBanner: vi.fn(), updateBannerState: vi.fn() }));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const windowListeners = [];
let runtimeListeners;

function request(type) {
  return new Promise(resolve => {
    for (const listener of runtimeListeners) listener({ type }, {}, resolve);
  });
}
function emit(type, fields) {
  window.dispatchEvent(new MessageEvent("message", { source: window,
    data: { source: "asterion-main-world", type, ...fields } }));
}
async function start() {
  await request("asterion:popup-start"); await flush();
  return (await request("asterion:get-status")).sessionId;
}
async function setup(platform) {
  vi.resetModules(); vi.useFakeTimers();
  platformState.id = platform;
  runtimeListeners = [];
  const audio = deferred(), caption = deferred(), finalization = deferred();
  globalThis.chrome = {
    storage: { onChanged: { addListener: vi.fn() }, local: { get: vi.fn((defaults, callback) => {
      const result = { ...defaults, autoStart: false };
      callback?.(result); return Promise.resolve(result);
    }) } },
    runtime: {
      onMessage: { addListener: listener => runtimeListeners.push(listener) },
      sendMessage: vi.fn(async message => {
        if (message.type === "asterion:session-starting") return { folderName: "folder" };
        if (message.type === "asterion:chunk") return audio.promise;
        if (message.type === "asterion:caption-event") return caption.promise;
        if (message.type === "asterion:session-ended") return finalization.promise;
        return {};
      }),
    },
  };
  const addListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, callback, options) => {
    windowListeners.push([type, callback]); addListener(type, callback, options);
  });
  vi.spyOn(window, "postMessage").mockImplementation(() => {});
  await import("./meet-detector.js"); await flush();
  return { audio, caption, finalization };
}

afterEach(() => {
  for (const [type, listener] of windowListeners.splice(0)) window.removeEventListener(type, listener);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); delete globalThis.chrome;
});

describe.each(["meet", "teams"])("%s capture finalization", platform => {
  it("shows saving, processing and completion as the session is published", async () => {
    const { finalization } = await setup(platform);
    const { updateBannerState } = await import("./meet-banner.js");
    const sessionId = await start();
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    expect(updateBannerState).toHaveBeenCalledWith("saving", expect.objectContaining({ captureSessionId: sessionId }));
    finalization.resolve({ sessionId, folderName: "folder", processing: { revision: 1, pending: true } }); await flush();
    expect(updateBannerState).toHaveBeenLastCalledWith("processing", expect.objectContaining({ captureSessionId: sessionId }));
    const onStorageChanged = chrome.storage.onChanged.addListener.mock.calls[0][0];
    onStorageChanged({ meetingHistory: { newValue: [{ sessionId, processing: { revision: 2, pending: false } }] } }, "local");
    expect(updateBannerState).toHaveBeenLastCalledWith("finished", expect.objectContaining({ captureSessionId: sessionId }));
  });

  it("keeps ownership while real chunk and caption deliveries drain and another recording starts", async () => {
    const { audio, caption, finalization } = await setup(platform);
    const sessionId = await start();
    emit("asterion:chunk", { sessionId, stream: "meeting", generation: 0, seq: 1,
      captureTs: Date.now(), buffer: new Uint8Array([7]).buffer });
    platformState.onCaption({ source: "dom", utteranceId: "one", revision: 1,
      text: "Final words", speaker: "Ana", firstReceivedAt: Date.now(), updatedAt: Date.now() });
    emit("asterion:session-ended", { sessionId, endedAt: Date.now(), expectedSequences: { meeting: 1 } });
    await flush();
    expect(await request("asterion:get-status")).toMatchObject({ sessionId: null, platform, drainingSessionIds: [sessionId] });
    const nextSessionId = await start();
    expect(nextSessionId).not.toBe(sessionId);
    expect(await request("asterion:get-status")).toMatchObject({ sessionId: nextSessionId, drainingSessionIds: [sessionId] });
    audio.resolve({ committed: true, durable: true }); await flush();
    expect(chrome.runtime.sendMessage.mock.calls.some(([message]) => message.type === "asterion:session-ended")).toBe(false);
    caption.resolve({ committed: true, durable: true, eventSeq: 1 }); await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "asterion:session-ended", sessionId, expectedCaptionEvents: 1,
      persistenceErrors: [], captionPersistenceErrors: [], expectedSequences: { meeting: 1 },
    }));
    expect(await request("asterion:get-status")).toMatchObject({ drainingSessionIds: [sessionId] });
    finalization.resolve({ folderName: "folder" }); await flush();
    expect(await request("asterion:get-status")).toMatchObject({ sessionId: nextSessionId, drainingSessionIds: [] });
  });

  it("releases ownership after finalization transport failure so recovery can retry", async () => {
    const { finalization } = await setup(platform);
    const sessionId = await start();
    emit("asterion:session-ended", { sessionId, endedAt: Date.now() }); await flush();
    expect(await request("asterion:get-status")).toMatchObject({ drainingSessionIds: [sessionId] });
    finalization.reject(new Error("Storage transport unavailable")); await flush();
    expect(await request("asterion:get-status")).toMatchObject({ sessionId: null, drainingSessionIds: [] });
    const { updateBannerState } = await import("./meet-banner.js");
    expect(updateBannerState).toHaveBeenLastCalledWith("capture-error", expect.any(Object));
  });
});
