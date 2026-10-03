import { beforeEach, describe, expect, it, vi } from "vitest";

function mockChromeStorage() {
  const store = {};
  return {
    local: {
      get: vi.fn((defaults) => {
        const keys = Object.keys(defaults);
        const result = {};
        for (const key of keys) result[key] = key in store ? store[key] : defaults[key];
        return Promise.resolve(result);
      }),
      set: vi.fn((values) => {
        Object.assign(store, values);
        return Promise.resolve();
      }),
    },
    __store: store,
  };
}

function baseChromeMock() {
  return {
    storage: mockChromeStorage(),
    runtime: { onMessage: { addListener: () => {} }, getContexts: vi.fn().mockResolvedValue([{}]), getURL: (p) => p },
    tabs: { onRemoved: { addListener: () => {} } },
    webNavigation: { onCommitted: { addListener: () => {} } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  };
}

describe("active session registry", () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.chrome = baseChromeMock();
  });

  it("registerActiveSession stores sessionId, tabId and meetingTitle", async () => {
    const { registerActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");
    expect(await findActiveSessionIdsForTab(42)).toEqual(["session-1"]);
  });

  it("findActiveSessionIdsForTab returns an empty array when no session matches", async () => {
    const { findActiveSessionIdsForTab } = await import("./service-worker.js");
    expect(await findActiveSessionIdsForTab(999)).toEqual([]);
  });

  it("unregisterActiveSession removes the entry", async () => {
    const { registerActiveSession, unregisterActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");
    await unregisterActiveSession("session-1");
    expect(await findActiveSessionIdsForTab(42)).toEqual([]);
  });

  it("supports multiple sessions registered for different tabs sequentially", async () => {
    const { registerActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");
    await registerActiveSession("session-2", 43, "1:1");
    expect(await findActiveSessionIdsForTab(42)).toEqual(["session-1"]);
    expect(await findActiveSessionIdsForTab(43)).toEqual(["session-2"]);
  });

  it("keeps both sessions when two are registered concurrently (no lost update)", async () => {
    const { registerActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await Promise.all([
      registerActiveSession("session-1", 42, "Daily sync"),
      registerActiveSession("session-2", 43, "1:1"),
    ]);
    expect(await findActiveSessionIdsForTab(42)).toEqual(["session-1"]);
    expect(await findActiveSessionIdsForTab(43)).toEqual(["session-2"]);
  });
});

describe("emergency finalize on tab close", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sends asterion:session-ended for a session whose tab was closed", async () => {
    let onRemovedHandler;
    const sendMessage = vi.fn().mockResolvedValue({});
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      tabs: { onRemoved: { addListener: (fn) => { onRemovedHandler = fn; } } },
    };

    const { registerActiveSession } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");

    await onRemovedHandler(42);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null })
    );
  });

  it("does nothing when the closed tab has no active session", async () => {
    let onRemovedHandler;
    const sendMessage = vi.fn().mockResolvedValue({});
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      tabs: { onRemoved: { addListener: (fn) => { onRemovedHandler = fn; } } },
    };

    await import("./service-worker.js");
    await onRemovedHandler(999);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends asterion:session-ended when the top frame of a recording tab navigates away", async () => {
    let onCommittedHandler;
    const sendMessage = vi.fn().mockResolvedValue({});
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      webNavigation: { onCommitted: { addListener: (fn) => { onCommittedHandler = fn; } } },
    };

    const { registerActiveSession } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");

    await onCommittedHandler({ tabId: 42, frameId: 0 });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null })
    );
  });

  it("ignores onCommitted events for subframes (frameId !== 0)", async () => {
    let onCommittedHandler;
    const sendMessage = vi.fn().mockResolvedValue({});
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      webNavigation: { onCommitted: { addListener: (fn) => { onCommittedHandler = fn; } } },
    };

    const { registerActiveSession } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");

    await onCommittedHandler({ tabId: 42, frameId: 7 });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("storage RPC and restored history", () => {
  let listeners;
  beforeEach(() => {
    vi.resetModules(); listeners = [];
    globalThis.chrome = baseChromeMock();
    chrome.runtime.onMessage.addListener = (listener) => listeners.push(listener);
    chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ committed: true, durable: true });
  });
  async function dispatch(message, sender = {}) {
    let owners = 0;
    const response = await new Promise((resolve) => {
      for (const listener of listeners) if (listener(message, sender, resolve) === true) owners++;
    });
    expect(owners).toBe(1); return response;
  }
  it("forwards to a distinct target and preserves the durable ACK with one responder", async () => {
    const { registerActiveSession } = await import("./service-worker.js");
    await registerActiveSession("s", 7, "Meeting", "folder");
    const response = await dispatch({ type: "asterion:chunk", sessionId: "s", seq: 3, generation: 1, stream: "meeting" });
    expect(response).toMatchObject({ committed: true, durable: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ target: "asterion-offscreen", folderName: "folder", tabId: 7 }));
    const ignore = vi.fn(); for (const listener of listeners) expect(listener({ target: "asterion-offscreen", type: "asterion:chunk" }, {}, ignore)).toBeUndefined();
    expect(ignore).not.toHaveBeenCalled();
  });
  it("persists the folder returned by initialization and does not duplicate restored history", async () => {
    await import("./service-worker.js");
    chrome.runtime.sendMessage.mockResolvedValueOnce({ folderName: "durable-folder" });
    await dispatch({ type: "asterion:session-starting", sessionId: "s", meetingTitle: "Meeting" }, { tab: { id: 7 } });
    expect(chrome.storage.__store.activeRecordingSessions.s.folderName).toBe("durable-folder");
    const meta = { type: "asterion:session-finalized", sessionId: "s", folderName: "durable-folder", startedAt: 100, endedAt: 200, recordingStatus: "incomplete" };
    await dispatch(meta); await dispatch(meta);
    expect(chrome.storage.__store.meetingHistory).toHaveLength(1);
    expect(chrome.storage.__store.meetingHistory[0].recordingStatus).toBe("incomplete");
  });
  it("recreates offscreen once for concurrent transport recovery", async () => {
    await import("./service-worker.js");
    let finish; const gate = new Promise((resolve) => { finish = resolve; });
    chrome.offscreen = { closeDocument: vi.fn(() => gate), createDocument: vi.fn().mockResolvedValue() };
    const a = dispatch({ type: "asterion:recover-storage", sessionId: "s" });
    const b = dispatch({ type: "asterion:recover-storage", sessionId: "s" });
    await vi.waitFor(() => expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce());
    finish(); await Promise.all([a, b]); expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
  });
});
