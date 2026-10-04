import { beforeEach, describe, expect, it, vi } from "vitest";

const writerState = vi.hoisted(() => ({ instances: [], write: vi.fn() }));

vi.mock("../storage/session-writer.js", () => ({
  SessionWriter: class {
    constructor({ sessionId }) {
      this.sessionId = sessionId;
      this.ready = Promise.resolve();
      this.folderName = "x";
      this.finalizeCalls = 0;
      this.onConversionsFinished = null;
      writerState.instances.push(this);
    }
    getStorageSnapshot() { return {}; }
    onCaptionSnapshot() {}
    onCaptionEvent() { return writerState.write(); }
    onSpeakerLabel() {}
    writeChunk() {
      return writerState.write();
    }
    async finalize() {
      this.finalizeCalls += 1;
      return { sessionId: this.sessionId, folderName: "x" };
    }
  },
}));

describe("offscreen session-ended deduplication", () => {
  let messageListener;

  beforeEach(() => {
    vi.resetModules();
    writerState.instances = [];
    writerState.write.mockReset().mockResolvedValue({ seq: 1, generation: 0 });
    globalThis.chrome = {
      storage: { local: { get: async () => ({ debugLogging: false }) } },
      runtime: {
        onMessage: { addListener: (fn) => { messageListener = fn; } },
        sendMessage: vi.fn().mockResolvedValue({}),
      },
    };
  });

  it("only finalizes once and sends session-finalized once when session-ended arrives twice", async () => {
    await import("./offscreen.js");
    await new Promise((resolve) => messageListener({ target: "asterion-offscreen", type: "asterion:session-starting", sessionId: "session-1", meetingTitle: "Daily" }, {}, resolve));
    await new Promise((resolve) => messageListener({ target: "asterion-offscreen", type: "asterion:session-ended", sessionId: "session-1", muteManifest: null, endedAt: 1000 }, {}, resolve));
    await new Promise((resolve) => messageListener({ target: "asterion-offscreen", type: "asterion:session-ended", sessionId: "session-1", muteManifest: null, endedAt: 1000 }, {}, resolve));
    await Promise.resolve();
    await Promise.resolve();

    const writer = writerState.instances[0];
    expect(writer.finalizeCalls).toBe(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("responds to chunks only after persistence and keeps unrelated messages available to their owners", async () => {
    await import("./offscreen.js");
    expect(messageListener({ target: "asterion-offscreen", type: "asterion:get-video-preset" }, {}, vi.fn())).toBeUndefined();
    await new Promise((resolve) => messageListener({ target: "asterion-offscreen", type: "asterion:session-starting", sessionId: "session-1" }, {}, resolve));
    let release; writerState.write.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const response = vi.fn();
    expect(messageListener({ target: "asterion-offscreen", type: "asterion:chunk", sessionId: "session-1", stream: "meeting", bufferBase64: "AQ==", seq: 1, generation: 0 }, {}, response)).toBe(true);
    await vi.waitFor(() => expect(writerState.write).toHaveBeenCalled());
    expect(response).not.toHaveBeenCalled();
    release({ seq: 1, generation: 0 });
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ committed: true, seq: 1, generation: 0 }));
  });

  it("responds to captions only after their durable write", async () => {
    await import("./offscreen.js");
    await new Promise(resolve => messageListener({ target: "asterion-offscreen", type: "asterion:session-starting", sessionId: "s" }, {}, resolve));
    let release; writerState.write.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const response = vi.fn();
    messageListener({ target: "asterion-offscreen", type: "asterion:caption-event", sessionId: "s", event: { eventSeq: 1 } }, {}, response);
    await vi.waitFor(() => expect(writerState.write).toHaveBeenCalled()); expect(response).not.toHaveBeenCalled();
    release({ durable: true, eventSeq: 1 });
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ committed: true, durable: true, eventSeq: 1 }));
  });

  it("distinguishes transport initialization from an exhausted storage write", async () => {
    await import("./offscreen.js");
    const chunk = { target: "asterion-offscreen", type: "asterion:chunk", sessionId: "session-1", stream: "meeting", bufferBase64: "AQ==" };
    const missing = await new Promise((resolve) => messageListener(chunk, {}, resolve));
    expect(missing).toMatchObject({ retryable: true });
    await new Promise((resolve) => messageListener({ target: "asterion-offscreen", type: "asterion:session-starting", sessionId: "session-1" }, {}, resolve));
    writerState.write.mockRejectedValueOnce(Object.assign(new Error("disk write failed"), { retryable: false }));
    const failed = await new Promise((resolve) => messageListener(chunk, {}, resolve));
    expect(failed).toMatchObject({ error: "disk write failed", retryable: false });
  });

});
