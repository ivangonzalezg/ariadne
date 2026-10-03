import { beforeEach, describe, expect, it, vi } from "vitest";

const writerState = vi.hoisted(() => ({ instances: [], write: vi.fn() }));

vi.mock("../storage/session-writer.js", () => ({
  SessionWriter: class {
    constructor({ sessionId }) {
      this.sessionId = sessionId;
      this.ready = Promise.resolve();
      this.finalizeCalls = 0;
      this.onConversionsFinished = null;
      writerState.instances.push(this);
    }
    onCaptionSnapshot() {}
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
        sendMessage: vi.fn(),
      },
    };
  });

  it("only finalizes once and sends session-finalized once when session-ended arrives twice", async () => {
    await import("./offscreen.js");
    await messageListener({ type: "asterion:session-starting", sessionId: "session-1", meetingTitle: "Daily" }, {});
    await messageListener({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null, endedAt: 1000 }, {});
    await messageListener({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null, endedAt: 1000 }, {});
    await Promise.resolve();
    await Promise.resolve();

    const writer = writerState.instances[0];
    expect(writer.finalizeCalls).toBe(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("responds to chunks only after persistence and keeps unrelated messages available to their owners", async () => {
    await import("./offscreen.js");
    expect(messageListener({ type: "asterion:get-video-preset" }, {}, vi.fn())).toBeUndefined();
    await new Promise((resolve) => messageListener({ type: "asterion:session-starting", sessionId: "session-1" }, {}, resolve));
    let release; writerState.write.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const response = vi.fn();
    expect(messageListener({ type: "asterion:chunk", sessionId: "session-1", stream: "meeting", bufferBase64: "AQ==", seq: 1, generation: 0 }, {}, response)).toBe(true);
    await vi.waitFor(() => expect(writerState.write).toHaveBeenCalled());
    expect(response).not.toHaveBeenCalled();
    release({ seq: 1, generation: 0 });
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ committed: true, seq: 1, generation: 0 }));
  });

  it("distinguishes transport initialization from an exhausted storage write", async () => {
    await import("./offscreen.js");
    const chunk = { type: "asterion:chunk", sessionId: "session-1", stream: "meeting", bufferBase64: "AQ==" };
    const missing = await new Promise((resolve) => messageListener(chunk, {}, resolve));
    expect(missing).toMatchObject({ retryable: true });
    await new Promise((resolve) => messageListener({ type: "asterion:session-starting", sessionId: "session-1" }, {}, resolve));
    writerState.write.mockRejectedValueOnce(new Error("disk write failed"));
    const failed = await new Promise((resolve) => messageListener(chunk, {}, resolve));
    expect(failed).toEqual({ error: "disk write failed", retryable: false });
  });

});
