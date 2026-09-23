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
    const sendMessage = vi.fn();
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
    const sendMessage = vi.fn();
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      tabs: { onRemoved: { addListener: (fn) => { onRemovedHandler = fn; } } },
    };

    await import("./service-worker.js");
    await onRemovedHandler(999);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
