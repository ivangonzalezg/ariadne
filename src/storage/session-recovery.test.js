import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { MemoryDirectoryHandle } from "../../tests/helpers/memory-opfs.js";
const ffmpeg = vi.hoisted(() => ({ runFfmpegAttempt: vi.fn() }));
vi.mock("../offscreen/ffmpeg-client.js", () => ffmpeg);
import { SessionWriter } from "./session-writer.js";
import { conversionQueue, processingQueue } from "../offscreen/conversion-queue.js";
import { recoverySettled } from "./session-recovery.js";
import { readJson, writeFile } from "./capture-journal.js";
let root;
let index = 0;
const done = writer => vi.waitFor(() => {
  expect(writer.recovery.snapshot().pending).toBe(false);
  expect([...conversionQueue.snapshot(), ...processingQueue.snapshot()].filter(job => job.sessionId === writer.sessionId)).toEqual([]);
});
async function captured({ video = false, captions = false } = {}) {
  const writer = new SessionWriter({ sessionId: `recovery-${++index}`, tabId: 7, meetingTitle: "Interrupted meeting" });
  await writer.ready;
  await writer.writeChunk("meeting", new Uint8Array([1, 2]), { seq: 1, captureTs: writer.startedAt + 2000 });
  if (video) await writer.writeChunk("video", new Uint8Array([3, 4]), { seq: 1, captureTs: writer.startedAt + 2000 });
  if (captions) await writer.onCaptionEvent({ sessionId: writer.sessionId, source: "dom", eventSeq: 1,
    utteranceId: "one", revision: 1, speaker: "Ana", text: "Saved words", firstReceivedAt: writer.startedAt + 100,
    updatedAt: writer.startedAt + 150 });
  return writer;
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true }) } });
  root = new MemoryDirectoryHandle("root");
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
  ffmpeg.runFfmpegAttempt.mockReset().mockResolvedValue(new Uint8Array([9]));
});
afterEach(async () => {
  for (const queue of [conversionQueue, processingQueue]) {
    for (const sessionId of new Set(queue.snapshot().map(job => job.sessionId))) await queue.cancelSession(sessionId);
    clearTimeout(queue.timer);
  }
  vi.useRealTimers();
});

describe("interrupted session recovery", () => {
  it("migrates old incomplete sessions and publishes them as completed", async () => {
    const writer = await captured({ captions: true });
    await writer.checkpoint({ recordingStatus: "incomplete", transcriptStatus: "incomplete",
      endedAt: writer.startedAt + 3000, interruptionReason: "capture-tab-disappeared", historyPublished: true });
    const restored = await SessionWriter.restore(writer.folderName);
    await restored.resumeRecovery(); await done(restored);
    const manifest = await readJson(restored.meetingHandle, "manifest.json");
    expect(manifest).toMatchObject({ recordingStatus: "complete", transcriptStatus: "complete",
      audioConversionStatus: "succeeded", hasAudioMp3: true, transcriptExportStatus: "succeeded", hasTranscript: true });
    expect(await readJson(restored.meetingHandle, "transcripcion.json")).toMatchObject([{ text: "Saved words", speaker: "Ana" }]);
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledOnce();
  });

  it("uses durable capture time when a browser reopens much later", async () => {
    const writer = await captured();
    const restored = await SessionWriter.restore(writer.folderName);
    await restored.finalize({ interruptionReason: "capture-tab-disappeared" }); await done(restored);
    expect(restored.endedAt).toBe(writer.startedAt + 2000);
    expect(restored.getMetadata().durationMs).toBe(2000);
  });

  it("stops at a corrupt middle chunk, preserving all original records", async () => {
    const writer = await captured();
    await writer.writeChunk("meeting", new Uint8Array([3]), { seq: 2 });
    await writer.writeChunk("meeting", new Uint8Array([4]), { seq: 3 });
    const record = writer.journal.recordsDirectory.files.get("meeting-0-2.chunk");
    record.bytes[record.bytes.length - 1] ^= 1;
    await writer.checkpoint({ recordingStatus: "incomplete", endedAt: writer.startedAt + 4000 });
    const restored = await SessionWriter.restore(writer.folderName);
    await restored.resumeRecovery(); await done(restored);
    expect(ffmpeg.runFfmpegAttempt.mock.calls[0][0].inputs).toEqual([new Uint8Array([1, 2])]);
    expect(restored.recovery.snapshot().recoveredCoverage.meeting).toMatchObject({ lastSequence: 1, partial: true, gaps: [2] });
    expect(restored.journal.recordsDirectory.files.size).toBe(3);
  });

  it("reports an unusable prefix without producing an empty artifact", async () => {
    const writer = await captured();
    await writer.journal.recordsDirectory.removeEntry("meeting-0-1.chunk");
    await writer.writeChunk("meeting", new Uint8Array([3]), { seq: 2 });
    await writer.checkpoint({ recordingStatus: "incomplete", endedAt: writer.startedAt + 4000 });
    const restored = await SessionWriter.restore(writer.folderName);
    await restored.resumeRecovery(); await done(restored);
    expect(restored.getMetadata().audioConversionStatus).toBe("failed");
    expect(ffmpeg.runFfmpegAttempt).not.toHaveBeenCalled();
    expect(restored.meetingHandle.files.has("audio-reunion.mp3")).toBe(false);
  });

  it("keeps an exhausted conversion failed until a deduplicated manual retry", async () => {
    const writer = await captured({ video: true });
    ffmpeg.runFfmpegAttempt.mockRejectedValueOnce(new Error("INPUT_INVALID"));
    await writer.finalize({}); await done(writer);
    expect(writer.getMetadata()).toMatchObject({ audioConversionStatus: "failed", videoConversionStatus: "succeeded" });
    await writer.resumeRecovery(); await done(writer);
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledTimes(2);
    await Promise.all([writer.resumeRecovery({ retry: true }), writer.resumeRecovery({ retry: true })]); await done(writer);
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledTimes(3);
    expect(writer.getMetadata()).toMatchObject({ audioConversionStatus: "succeeded", videoConversionStatus: "succeeded" });
  });

  it("recovers a closed artifact whose running job checkpoint was interrupted without re-encoding", async () => {
    const writer = await captured();
    await writeFile(writer.meetingHandle, "audio-reunion.mp3", new Uint8Array([9]));
    await writer.checkpoint({ recordingStatus: "complete", endedAt: writer.startedAt + 3000,
      conversions: [{ sessionId: writer.sessionId, stream: "meeting", state: "running", attempts: 3, createdAt: 0, nextAttemptAt: 0 }] });
    const restored = await SessionWriter.restore(writer.folderName);
    await restored.resumeRecovery(); await done(restored);
    expect(restored.getMetadata().hasAudioMp3).toBe(true);
    expect(ffmpeg.runFfmpegAttempt).not.toHaveBeenCalled();
  });

  it("regenerates a missing successful output on reconciliation", async () => {
    const writer = await captured(); await writer.finalize({}); await done(writer);
    await writer.meetingHandle.removeEntry("audio-reunion.mp3");
    await writer.resumeRecovery(); await done(writer);
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledTimes(2);
    expect(writer.getMetadata().hasAudioMp3).toBe(true);
  });

  it("retries transcript export independently of how capture ended", async () => {
    const writer = await captured({ captions: true });
    const file = await writer.meetingHandle.getFileHandle("transcripcion.json", { create: true });
    const createWritable = file.createWritable.bind(file);
    vi.spyOn(file, "createWritable").mockRejectedValueOnce(new Error("temporary export failure"));
    await writer.finalize({ interruptionReason: "capture-tab-disappeared" });
    await vi.waitFor(() => expect(writer.getMetadata().hasAudioMp3).toBe(true));
    expect(writer.getMetadata()).toMatchObject({ transcriptExportStatus: "pending", hasTranscript: false, transcriptStatus: "complete" });
    file.createWritable = createWritable;
    const transcriptTask = writer.recovery.tasks.find(job => job.stream === "transcript");
    transcriptTask.nextAttemptAt = Date.now(); processingQueue.wake();
    await done(writer);
    expect(writer.getMetadata()).toMatchObject({ hasTranscript: true, transcriptExportStatus: "succeeded", transcriptStatus: "complete" });
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledOnce();
  });

  it("bounds publication failures at ten and retries metadata without re-encoding", async () => {
    const writer = await captured();
    chrome.runtime.sendMessage.mockImplementation(async message => message.type === "asterion:session-finalized" ? { error: "History offline" } : { ok: true });
    await writer.finalize({});
    await vi.waitFor(() => expect(writer.getMetadata().hasAudioMp3).toBe(true));
    const publication = writer.recovery.tasks.find(job => job.stream === "publication");
    for (let attempts = publication.attempts; attempts < 10; attempts++) {
      await vi.waitFor(() => expect(publication.state).toBe("waiting"));
      publication.nextAttemptAt = Date.now(); processingQueue.wake();
      await vi.waitFor(() => expect(publication.attempts).toBeGreaterThan(attempts));
    }
    await done(writer);
    expect(publication.state).toBe("failed");
    const restored = await SessionWriter.restore(writer.folderName);
    await restored.resumeRecovery(); await done(restored);
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledOnce();
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true });
    await restored.resumeRecovery({ retry: true }); await done(restored);
    expect(restored.recovery.snapshot().canRetry).toBe(false);
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledOnce();
  });

  it("retains valid transcript bytes when a later empty model is encountered", async () => {
    const writer = await captured();
    const content = JSON.stringify([{ index: 0, startTime: 0, endTime: 1, text: "Retained", speaker: "Ana" }]);
    await writeFile(writer.meetingHandle, "transcripcion.json", content);
    await writer.finalize({}); await done(writer);
    expect(await readJson(writer.meetingHandle, "transcripcion.json")).toMatchObject([{ text: "Retained" }]);
  });

  it("makes quota errors terminal and leaves the durable transcript events available", async () => {
    const writer = await captured({ captions: true });
    const file = await writer.meetingHandle.getFileHandle("transcripcion.json", { create: true });
    vi.spyOn(file, "createWritable").mockRejectedValue(new DOMException("Full", "QuotaExceededError"));
    await writer.finalize({}); await done(writer);
    expect(writer.getMetadata()).toMatchObject({ transcriptExportStatus: "failed", hasTranscript: false, audioConversionStatus: "succeeded" });
    expect(writer.captions.events.size).toBe(1);
    expect(file.createWritable).toHaveBeenCalledOnce();
  });
});

it("restores all 501 committed chunks from the supplied interrupted-session shape", async () => {
  const writer = await captured();
  for (let seq = 2; seq <= 501; seq++) await writer.writeChunk("meeting", new Uint8Array([seq % 256]), {
    seq, generation: 0, captureTs: writer.startedAt + seq * 2000 });
  await writer.checkpoint({ recordingStatus: "incomplete", endedAt: writer.startedAt + 1023391,
    interruptionReason: "capture-tab-disappeared", conversions: [], historyPublished: true });
  const restored = await SessionWriter.restore(writer.folderName);
  await restored.resumeRecovery(); await done(restored);
  expect(restored.getMetadata()).toMatchObject({ recordingStatus: "complete", audioConversionStatus: "succeeded", hasAudioMp3: true });
  expect(restored.journal.records.size).toBe(501);
  expect(restored.recovery.snapshot().recoveredCoverage.meeting.lastSequence).toBe(501);
  expect(ffmpeg.runFfmpegAttempt.mock.calls[0][0].inputs[0].byteLength).toBe(502);
});

it("keeps a valid older transcript available while its failed latest export waits for manual retry", async () => {
  const writer = await captured({ captions: true });
  await writeFile(writer.meetingHandle, "transcripcion.json", JSON.stringify([{ text: "Older", speaker: "Ana", index: 0, startTime: 0, endTime: 1 }]));
  await writer.checkpoint({ recordingStatus: "complete", endedAt: writer.startedAt + 3000, transcriptExportError: "Previous export failed",
    recoveryTasks: [{ sessionId: writer.sessionId, stream: "transcript", state: "failed", attempts: 10, published: true, nextAttemptAt: 0, createdAt: 0 }] });
  const restored = await SessionWriter.restore(writer.folderName);
  await restored.resumeRecovery(); await done(restored);
  expect(restored.getMetadata()).toMatchObject({ hasTranscript: true, transcriptExportStatus: "failed" });
  expect(await readJson(restored.meetingHandle, "transcripcion.json")).toMatchObject([{ text: "Older" }]);
  await restored.resumeRecovery({ retry: true }); await done(restored);
  expect(await readJson(restored.meetingHandle, "transcripcion.json")).toMatchObject([{ text: "Saved words" }]);
  expect(restored.getMetadata().transcriptExportStatus).toBe("succeeded");
});

it("publishes the meeting in history even when the manifest cannot be written", async () => {
  const writer = await captured();
  const manifest = await writer.meetingHandle.getFileHandle("manifest.json", { create: true });
  vi.spyOn(manifest, "createWritable").mockRejectedValue(new DOMException("Full", "QuotaExceededError"));
  await writer.finalize({});
  await vi.waitFor(() => expect(writer.getMetadata().audioConversionStatus).toBe("succeeded"));
  await done(writer);
  const publications = chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === "asterion:session-finalized");
  expect(publications.length).toBeGreaterThan(0);
  expect(publications[0][0].processing.tasks.find(job => job.stream === "publication")).toMatchObject({ state: "failed", error: "Full" });
});


it("republishes settled v1 metadata as a completed recording without re-encoding or changing transcript bytes", async () => {
  const writer = await captured({ captions: true });
  await writer.finalize({}); await done(writer);
  const captionFile = writer.meetingHandle.files.get("transcripcion.json");
  const captionBytes = captionFile.bytes.slice();
  const manifest = await readJson(writer.meetingHandle, "manifest.json");
  await writeFile(writer.meetingHandle, "manifest.json", JSON.stringify({ ...manifest,
    recordingStatus: "incomplete", transcriptStatus: "incomplete", interruptionReason: "capture-tab-disappeared" }));
  await writer.checkpoint({ recoveryVersion: 1, recordingStatus: "incomplete", transcriptStatus: "incomplete",
    interruptionReason: "capture-tab-disappeared", recoveredCoverage: { meeting: { partial: true, gaps: [] } } });
  expect(await recoverySettled(writer.meetingHandle, writer.journal.state)).toBe(false);
  const restored = await SessionWriter.restore(writer.folderName);
  await restored.resumeRecovery(); await done(restored);
  const republished = await readJson(restored.meetingHandle, "manifest.json");
  expect(republished).toMatchObject({ recordingStatus: "complete", transcriptStatus: "complete",
    recoveredCoverage: { meeting: { partial: false } }, audioConversionStatus: "succeeded", transcriptExportStatus: "succeeded" });
  expect(republished).not.toHaveProperty("interruptionReason");
  expect(restored.journal.state.interruptionReason).toBe("capture-tab-disappeared");
  expect(await recoverySettled(restored.meetingHandle, restored.journal.state)).toBe(true);
  expect(captionFile.bytes).toEqual(captionBytes);
  expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledOnce();
});
