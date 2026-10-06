import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { Blob } from "node:buffer";
import { MemoryDirectoryHandle } from "../../tests/helpers/memory-opfs.js";

vi.mock("./ffmpeg-client.js", () => ({ runFfmpegAttempt: vi.fn() }));

describe("minimum meeting duration storage lifecycle", () => {
  let root, store, dispatch, queues;

  beforeEach(async () => {
    vi.resetModules();
    root = new MemoryDirectoryHandle("root");
    store = { minimumMeetingDurationSeconds: 10 };
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("Blob", Blob);
    Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
    const listeners = [];
    dispatch = (message, sender = {}) => new Promise((resolve, reject) => {
      let owned = false;
      for (const listener of listeners) if (listener(message, sender, resolve) === true) owned = true;
      if (!owned) reject(new Error(`No owner for ${message.type}`));
    });
    vi.stubGlobal("chrome", {
      storage: { local: {
        get: async defaults => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, store[key] ?? value])),
        set: async values => Object.assign(store, values),
      } },
      runtime: {
        onMessage: { addListener: listener => listeners.push(listener) },
        sendMessage: (message) => dispatch(message),
        getContexts: async () => [{}], getURL: path => path,
      },
      tabs: { onRemoved: { addListener() {} } },
      webNavigation: { onCommitted: { addListener() {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    });
    await import("../background/service-worker.js");
    await import("./offscreen.js");
    const { conversionQueue, processingQueue } = await import("./conversion-queue.js");
    queues = [conversionQueue, processingQueue];
  });

  afterEach(() => {
    for (const queue of queues) { clearTimeout(queue.timer); queue.jobs.clear(); }
    vi.unstubAllGlobals();
  });

  async function start() {
    const result = await dispatch({ type: "asterion:session-starting", sessionId: "short", meetingTitle: "Prueba" }, { tab: { id: 7 } });
    const directory = await root.getDirectoryHandle(result.folderName);
    const state = JSON.parse(await (await (await directory.getFileHandle("capture-state.json")).getFile()).text());
    return { directory, state, folderName: result.folderName };
  }

  it("discards captured audio and captions, removes the folder and registry, and never publishes history", async () => {
    const { directory, state } = await start();
    expect(state.minimumMeetingDurationSeconds).toBe(10);
    await dispatch({ type: "asterion:chunk", sessionId: "short", stream: "meeting", seq: 1, bufferBase64: "AQI=", captureTs: state.startedAt + 100 });
    await dispatch({ type: "asterion:caption-snapshot", sessionId: "short", snapshot: { text: "Prueba", speaker: "Ana", receivedAt: state.startedAt + 100 } });
    // Changes apply to future recordings; this one keeps its original minimum.
    store.minimumMeetingDurationSeconds = 0;
    const result = await dispatch({ type: "asterion:session-ended", sessionId: "short", endedAt: state.startedAt + 1000 });
    expect(result).toMatchObject({ discarded: true });
    expect(root.directories.size).toBe(0);
    expect(store.activeRecordingSessions).toEqual({});
    expect(store.pendingSessionDeletions).toEqual({});
    expect(store.meetingHistory).toEqual([]);
    expect(directory.files.has("transcripcion.json")).toBe(false);
    expect(directory.files.has("audio-reunion.mp3")).toBe(false);
    expect(queues.every(queue => queue.jobs.size === 0)).toBe(true);
  });

  it("retries interrupted cleanup using its persisted deletion intent", async () => {
    const { state } = await start();
    const remove = vi.spyOn(root, "removeEntry").mockRejectedValueOnce(new Error("Temporary deletion failure"));
    const result = await dispatch({ type: "asterion:session-ended", sessionId: "short", endedAt: state.startedAt + 1000 });
    expect(result).toMatchObject({ retryable: true });
    expect(Object.keys(store.pendingSessionDeletions)).toEqual(["short"]);
    expect(store.meetingHistory).toBeUndefined();
    const { recoverPendingSessions } = await import("../background/service-worker.js");
    await recoverPendingSessions();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(root.directories.size).toBe(0);
    expect(store.activeRecordingSessions).toEqual({});
    expect(store.pendingSessionDeletions).toEqual({});
    expect(store.meetingHistory).toEqual([]);
  });

  it("discovers a discarded capture awaiting cleanup without publishing or processing it", async () => {
    const { state } = await start();
    await dispatch({ target: "asterion-offscreen", type: "asterion:session-ended", sessionId: "short", endedAt: state.startedAt + 1000 });
    expect(root.directories.size).toBe(1);
    const { recoverPendingSessions } = await import("../background/service-worker.js");
    await recoverPendingSessions();
    expect(root.directories.size).toBe(0);
    expect(store.activeRecordingSessions).toEqual({});
    expect(store.meetingHistory).toEqual([]);
    expect(queues.every(queue => queue.jobs.size === 0)).toBe(true);
  });
});
