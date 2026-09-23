import { beforeEach, describe, expect, it, vi } from "vitest";

const writerState = vi.hoisted(() => ({ instances: [] }));

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
      return Promise.resolve();
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
    globalThis.chrome = {
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
});
