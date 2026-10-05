import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { MemoryDirectoryHandle } from "../../tests/helpers/memory-opfs.js";
const ffmpeg = vi.hoisted(() => ({ runFfmpegAttempt: vi.fn() }));
vi.mock("./ffmpeg-client.js", () => ffmpeg);
let listener, root, writer, queues;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("chrome", { storage: { local: { get: async () => ({ debugLogging: false }) } },
    runtime: { onMessage: { addListener: fn => { listener = fn; } }, sendMessage: vi.fn().mockResolvedValue({ ok: true }) } });
  root = new MemoryDirectoryHandle("root");
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
  const { SessionWriter } = await import("../storage/session-writer.js");
  const { conversionQueue, processingQueue } = await import("./conversion-queue.js"); queues = [conversionQueue, processingQueue];
  writer = new SessionWriter({ sessionId: "recover-rpc", tabId: 7, meetingTitle: "Recover RPC" }); await writer.ready;
  await writer.writeChunk("meeting", new Uint8Array([1]), { seq: 1 });
  await writer.checkpoint({ recordingStatus: "incomplete", endedAt: writer.startedAt + 2000, interruptionReason: "capture-tab-disappeared" });
  ffmpeg.runFfmpegAttempt.mockReset().mockResolvedValue(new Uint8Array([9]));
  await import("./offscreen.js");
});
afterEach(async () => {
  for (const queue of queues) {
    for (const id of new Set(queue.snapshot().map(job => job.sessionId))) await queue.cancelSession(id);
    clearTimeout(queue.timer);
  }
});
const rpc = (type, overrides = {}) => new Promise(resolve => listener({ type, target: "asterion-offscreen",
  sessionId: writer.sessionId, folderName: writer.folderName, ...overrides }, {}, resolve));

describe("offscreen recovery RPC", () => {
  it("validates the session identity even when another folder is already cached", async () => {
    const first = await rpc("asterion:get-recovery-status");
    expect(first.recovery.supported).toBe(true);
    expect(await rpc("asterion:get-recovery-status", { folderName: "different" })).toMatchObject({ error: "Session mismatch", retryable: false });
  });

  it("cancels conversion before deletion and never republishes a deleted folder", async () => {
    let started;
    const running = new Promise(resolve => { started = resolve; });
    ffmpeg.runFfmpegAttempt.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }); started();
    }));
    await rpc("asterion:retry-recovery"); await running;
    const result = await rpc("asterion:delete-session");
    expect(result).toEqual({ ok: true });
    expect(root.directories.has(writer.folderName)).toBe(false);
    expect(await rpc("asterion:recover-storage", { sessionId: undefined, folderName: undefined })).toMatchObject({ pending: false });
    expect(root.directories.has(writer.folderName)).toBe(false);
    expect(await rpc("asterion:retry-recovery")).toMatchObject({ error: "Session deleted", retryable: false });
  });

  it("reports legacy storage as unsupported while still allowing its deletion", async () => {
    const legacy = await root.getDirectoryHandle("legacy", { create: true });
    const file = await legacy.getFileHandle("audio-reunion.webm", { create: true });
    const writable = await file.createWritable(); await writable.write(new Uint8Array([1])); await writable.close();
    expect(await rpc("asterion:get-recovery-status", { folderName: "legacy", sessionId: "legacy" })).toMatchObject({ recovery: { supported: false } });
    expect(await rpc("asterion:delete-session", { folderName: "legacy", sessionId: "legacy" })).toEqual({ ok: true });
    expect(root.directories.has("legacy")).toBe(false);
  });
});
