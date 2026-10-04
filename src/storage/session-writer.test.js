import { beforeEach, describe, expect, it, vi } from "vitest";

const ffmpeg = vi.hoisted(() => ({ runFfmpegAttempt: vi.fn() }));

vi.mock("../offscreen/ffmpeg-client.js", () => ffmpeg);

import { SessionWriter } from "./session-writer.js";

import { MemoryDirectoryHandle } from "../../tests/helpers/memory-opfs.js";
import { webcrypto } from "node:crypto";
import { Blob } from "node:buffer";
import { conversionQueue } from "../offscreen/conversion-queue.js";

const waitFor = async (predicate) => {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

async function createWriter({ audio = true, video = true } = {}) {
  const writer = new SessionWriter({ sessionId: "session-1", tabId: 7, meetingTitle: "Daily sync" });
  await writer.ready;
  if (audio) await writer.writeChunk("meeting", new Uint8Array([1, 2]));
  if (video) await writer.writeChunk("video", new Uint8Array([3, 4]));
  return writer;
}

async function finishConversions(writer) {
  await new Promise((resolve) => {
    writer.onConversionsFinished = resolve;
  });
}

function manifestOf(writer) {
  const bytes = writer.meetingHandle.files.get("manifest.json").bytes;
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("SessionWriter conversion flow", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", Blob);
    clearTimeout(conversionQueue.timer); conversionQueue.jobs.clear(); conversionQueue.running = false;
    const root = new MemoryDirectoryHandle("root");
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { getDirectory: vi.fn().mockResolvedValue(root) },
    });
    ffmpeg.runFfmpegAttempt.mockReset();
  });

  it("drains caption writes, preserves same-speaker interventions, and exports the final revision after recovery", async () => {
    const writer = await createWriter({ audio: false, video: false });
    const event = (eventSeq, utteranceId, revision, text, offset) => ({ sessionId: writer.sessionId, source: "dom",
      eventSeq, utteranceId, revision, speaker: "Ana", speakerId: null, text,
      firstReceivedAt: writer.startedAt + offset, updatedAt: writer.startedAt + offset + revision });
    await writer.onCaptionEvent(event(1, "one", 1, "Hola", 1000));
    await writer.onCaptionEvent(event(2, "two", 1, "Segunda", 2000));
    const restored = await SessionWriter.restore(writer.folderName);
    const lastWrite = restored.onCaptionEvent(event(3, "one", 2, "Hola a todos", 1000));
    const result = await restored.finalize({ endedAt: writer.startedAt + 10000, expectedCaptionEvents: 3 });
    await lastWrite;
    const file = await restored.meetingHandle.getFileHandle("transcripcion.json");
    const segments = JSON.parse(await (await file.getFile()).text());
    expect(segments).toEqual([
      { index: 0, startTime: 1000, endTime: 1002, text: "Hola a todos", speaker: "Ana" },
      { index: 1, startTime: 2000, endTime: 2001, text: "Segunda", speaker: "Ana" },
    ]);
    expect(result).toMatchObject({ hasTranscript: true, transcriptStatus: "complete" });
    await expect(restored.onCaptionEvent(event(4, "three", 1, "Tardía", 9000))).rejects.toThrow("finalized");
  });

  it("does not block audio conversion if exporting the transcript fails", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false }); const finished = finishConversions(writer);
    await writer.onCaptionEvent({ sessionId: writer.sessionId, source: "dom", eventSeq: 1, utteranceId: "one", revision: 1,
      speaker: "Ana", text: "Hola", firstReceivedAt: writer.startedAt, updatedAt: writer.startedAt });
    const file = await writer.meetingHandle.getFileHandle("transcripcion.json", { create: true });
    file.createWritable = async () => { throw new Error("Transcript export failed"); };
    const result = await writer.finalize({ expectedCaptionEvents: 1 }); await finished;
    expect(result).toMatchObject({ recordingStatus: "complete", transcriptStatus: "incomplete", hasTranscript: false });
    expect(manifestOf(writer).audioConversionStatus).toBe("succeeded");
    expect(writer.captions.model.values()).toHaveLength(1);
  });

  it("marks caption gaps incomplete while retaining successful audio conversion", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false }); const finished = finishConversions(writer);
    const result = await writer.finalize({ endedAt: writer.startedAt + 1000, expectedCaptionEvents: 1,
      captionPersistenceErrors: [{ eventSeq: 1, message: "Unconfirmed" }] });
    await finished;
    expect(result).toMatchObject({ recordingStatus: "complete", transcriptStatus: "incomplete" });
    expect(manifestOf(writer)).toMatchObject({ transcriptStatus: "incomplete", audioConversionStatus: "succeeded" });
  });

  it("finalizes and returns metadata without waiting for conversion", async () => {
    const conversion = deferred();
    ffmpeg.runFfmpegAttempt.mockReturnValue(conversion.promise);
    const writer = await createWriter({ audio: true, video: false });

    const metadata = await writer.finalize({ muteManifest: { intervals: [] } });

    expect(metadata).toMatchObject({ sessionId: "session-1", tabId: 7, hasVideo: false });
    await waitFor(() => ffmpeg.runFfmpegAttempt.mock.calls.length === 1);
    expect(manifestOf(writer).audioConversionStatus).toBe("pending");

    conversion.resolve(new Uint8Array([9]));
    await finishConversions(writer);
  });

  it("converts audio to mp3 before video to mp4 and records both successes", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter();
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(ffmpeg.runFfmpegAttempt.mock.calls.map(([job]) => job.outputExt)).toEqual(["mp3", "mp4"]);
    expect(manifestOf(writer)).toMatchObject({
      audioConversionStatus: "succeeded",
      videoConversionStatus: "succeeded",
      hasAudioMp3: true,
      hasVideoMp4: true,
    });
  });

  it("continues with video conversion after an audio conversion failure", async () => {
    ffmpeg.runFfmpegAttempt.mockRejectedValueOnce(new Error("INPUT_INVALID: audio failed")).mockResolvedValueOnce(new Uint8Array([9]));
    const writer = await createWriter();
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(ffmpeg.runFfmpegAttempt.mock.calls.map(([job]) => job.outputExt)).toEqual(["mp3", "mp4"]);
    expect(manifestOf(writer)).toMatchObject({
      audioConversionStatus: "failed",
      videoConversionStatus: "succeeded",
      hasAudioMp3: false,
      hasVideoMp4: true,
    });
  });

  it("marks video conversion as skipped when no video stream was recorded", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledTimes(1);
    expect(manifestOf(writer)).toMatchObject({
      audioConversionStatus: "succeeded",
      videoConversionStatus: "skipped",
      hasAudioMp3: true,
      hasVideoMp4: false,
    });
  });

  it("writes transcripcion.json with camelCase segments relative to startedAt", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    writer.onCaptionSnapshot({ speaker: "Ana", text: "Hola", timestampMs: writer.startedAt + 1000 });
    writer.onCaptionSnapshot({ speaker: "Luis", text: "Hola de vuelta", timestampMs: writer.startedAt + 5000 });

    const endedAt = writer.startedAt + 8000;
    await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
    await finished;

    const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
    const segments = JSON.parse(new TextDecoder().decode(bytes));

    expect(segments).toEqual([
      { index: 0, startTime: 1000, endTime: 1000, text: "Hola", speaker: "Ana" },
      { index: 1, startTime: 5000, endTime: 8000, text: "Hola de vuelta", speaker: "Luis" },
    ]);
  });

  it("collapses consecutive snapshots from the same speaker into one segment", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    writer.onCaptionSnapshot({ speaker: "Ana", text: "Hola", timestampMs: writer.startedAt + 1000 });
    writer.onCaptionSnapshot({ speaker: "Ana", text: "Hola a todos", timestampMs: writer.startedAt + 2000 });
    writer.onCaptionSnapshot({ speaker: "Luis", text: "Buenas", timestampMs: writer.startedAt + 5000 });

    const endedAt = writer.startedAt + 6000;
    await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
    await finished;

    const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
    const segments = JSON.parse(new TextDecoder().decode(bytes));

    expect(segments).toEqual([
      { index: 0, startTime: 1000, endTime: 2000, text: "Hola a todos", speaker: "Ana" },
      { index: 1, startTime: 5000, endTime: 6000, text: "Buenas", speaker: "Luis" },
    ]);
  });

  it("does not write any transcript file when there were no captions", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(writer.meetingHandle.files.has("transcripcion.json")).toBe(false);
  });

  it("finalize() called twice returns the same result and does not run conversions twice", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    const [first, second] = await Promise.all([
      writer.finalize({ muteManifest: { intervals: [] } }),
      writer.finalize({ muteManifest: { intervals: [] } }),
    ]);
    await finished;

    expect(first).toEqual(second);
    expect(ffmpeg.runFfmpegAttempt).toHaveBeenCalledTimes(1);
  });

  it("writes a degraded muteManifest marker when none is provided (emergency finalize path)", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: null });
    await finished;

    expect(manifestOf(writer).muteManifest).toEqual({ intervals: [], degraded: true });
  });

  it("uses the reconciled speaker label instead of the raw caption speaker when one is available", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    writer.onSpeakerLabel({ speakerName: "Ivan Gonzalez", timestampMs: writer.startedAt + 900 });
    writer.onCaptionSnapshot({ speaker: "You", text: "Hola a todos", timestampMs: writer.startedAt + 1000 });

    const endedAt = writer.startedAt + 3000;
    await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
    await finished;

    const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
    const segments = JSON.parse(new TextDecoder().decode(bytes));

    // endTime es 3000 (no 1000): al haber un solo snapshot, el segmento queda
    // "abierto" hasta que finalizeCurrent(endedAt) lo cierra al final de la
    // sesión - mismo comportamiento que CaptionParser ya tiene hoy para el
    // último segmento de cualquier transcripción (ver el test existente
    // "writes transcripcion.json..." más arriba en este archivo, donde el
    // segmento de Luis también termina en endedAt y no en su propio timestamp).
    expect(segments).toEqual([
      { index: 0, startTime: 1000, endTime: 3000, text: "Hola a todos", speaker: "Ivan Gonzalez (You)" },
    ]);
  });

  it("keeps the original caption speaker when no speaker label was ever received", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    writer.onCaptionSnapshot({ speaker: "You", text: "Hola", timestampMs: writer.startedAt + 1000 });

    const endedAt = writer.startedAt + 2000;
    await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
    await finished;

    const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
    const segments = JSON.parse(new TextDecoder().decode(bytes));

    expect(segments).toEqual([{ index: 0, startTime: 1000, endTime: 2000, text: "Hola", speaker: "You" }]);
  });
  it("retries durable writes, accepts gaps and rejects conflicting identities", async () => {
    const writer = await createWriter({ audio: false, video: false });
    const directory = writer.journal.recordsDirectory;
    const file = await directory.getFileHandle("meeting-0-1.chunk", { create: true });
    const original = file.createWritable.bind(file);
    let attempts = 0;
    file.createWritable = async () => {
      if (++attempts < 3) throw new Error("temporary");
      return original();
    };
    await writer.writeChunk("meeting", new Uint8Array([1, 2]), { seq: 1, captureTs: 100 });
    expect(attempts).toBe(3);
    expect(await writer.writeChunk("meeting", new Uint8Array([1, 2]), { seq: 1, captureTs: 100 })).toMatchObject({ duplicate: true, durable: true });
    expect(writer.committedChunks).toBe(1);
    expect(await writer.writeChunk("meeting", new Uint8Array([3]), { seq: 3 })).toMatchObject({ gaps: [2] });
    await expect(writer.writeChunk("meeting", new Uint8Array([3]), { seq: 2, sessionId: "other" })).rejects.toThrow("Session mismatch");
    await expect(writer.writeChunk("meeting", new Uint8Array([9]), { seq: 1, captureTs: 100 })).rejects.toThrow("Conflicting duplicate");
  });

  it("concatenates independent generations with defaults and keeps original segments for repeated conversion", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ video: false });
    await writer.writeChunk("meeting", new Uint8Array([3, 4]), { seq: 2, generation: 1 });
    const finished = finishConversions(writer); await writer.finalize({}); await finished;
    expect(ffmpeg.runFfmpegAttempt.mock.calls[0][0]).toMatchObject({ inputs: [new Uint8Array([1, 2]), new Uint8Array([3, 4])], args: [], outputExt: "mp3" });
    expect(ffmpeg.runFfmpegAttempt.mock.calls[1][0]).toMatchObject({ outputExt: "webm", args: ["-c", "copy"] });
    expect([...writer.meetingHandle.files.get("meeting-segment-0.webm").bytes]).toEqual([1, 2]);
    const restored = await SessionWriter.restore(writer.folderName);
    const segments = await restored.journal.materialize("meeting");
    expect(segments).toHaveLength(2);
    expect(restored.committedChunks).toBe(2);
  });

  it("reports incomplete persistence instead of declaring a successful conversion", async () => {
    const writer = await createWriter({ video: false });
    await writer.writeChunk("meeting", new Uint8Array([3]), { seq: 3 });
    const finished = finishConversions(writer); await writer.finalize({}); await finished;
    expect(manifestOf(writer)).toMatchObject({ audioConversionStatus: "failed", hasAudioMp3: false });
    expect(manifestOf(writer).recordingStatus).toBe("incomplete");
    expect(ffmpeg.runFfmpegAttempt).not.toHaveBeenCalled();
  });

  it("preserves public WebM when the only populated generation follows a restart", async () => {
    ffmpeg.runFfmpegAttempt.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: false, video: false });
    await writer.writeChunk("meeting", new Uint8Array([5, 6]), { seq: 1, generation: 1 });
    const finished = finishConversions(writer); await writer.finalize({}); await finished;
    expect([...writer.meetingHandle.files.get("audio-reunion.webm").bytes]).toEqual([5, 6]);
  });

  it("isolates simultaneous meetings with the same title and timestamp", async () => {
    vi.useFakeTimers();
    try {
      const first = await createWriter({ audio: false, video: false });
      const second = new SessionWriter({ sessionId: "session-2", tabId: 8, meetingTitle: first.meetingTitle });
      await second.ready;
      expect(first.startedAt).toBe(second.startedAt); expect(first.meetingHandle.name).not.toBe(second.meetingHandle.name);
      await first.writeChunk("meeting", new Uint8Array([1]), { seq: 1 });
      await second.writeChunk("meeting", new Uint8Array([2]), { seq: 1 });
      await first.journal.materialize("meeting"); await second.journal.materialize("meeting");
      expect([...first.meetingHandle.files.get("audio-reunion.webm").bytes]).toEqual([1]);
      expect([...second.meetingHandle.files.get("audio-reunion.webm").bytes]).toEqual([2]);
      await expect(first.writeChunk("meeting", new Uint8Array([3]), { seq: 1, generation: 1 })).rejects.toThrow("Conflicting chunk generation");
    } finally { vi.useRealTimers(); }
  });

});

it("restores captions, speaker labels and a partial mute checkpoint and marks interrupted metadata degraded", async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", Blob);
  const root = new MemoryDirectoryHandle("root"); Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
  const writer = new SessionWriter({ sessionId: "restore-metadata", tabId: 7, meetingTitle: "Metadata" }); await writer.ready;
  await writer.writeChunk("meeting", new Uint8Array([1]), { seq: 1 });
  await writer.onCaptionSnapshot({ speaker: "You", text: "Saved", timestampMs: writer.startedAt + 100 });
  await writer.onSpeakerLabel({ speakerName: "Local", timestampMs: writer.startedAt + 50 });
  await writer.checkpoint({ muteManifest: { intervals: [{ startMs: 10, endMs: 40 }], openIntervalStartMs: 100 } });
  const restored = await SessionWriter.restore(writer.folderName);
  const meta = await restored.finalize({ interruptionReason: "capture-tab-disappeared", endedAt: writer.startedAt + 1000 });
  expect(meta.recordingStatus).toBe("incomplete");
  expect(manifestOf(restored)).toMatchObject({ metadataDegraded: true, audioConversionStatus: "failed", hasAudioMp3: false,
    muteManifest: { degraded: true, intervals: [{ startMs: 10, endMs: 40 }], openIntervalStartMs: 100 } });
  expect(JSON.parse(new TextDecoder().decode(restored.meetingHandle.files.get("transcripcion.json").bytes))[0]).toMatchObject({ text: "Saved", speaker: "Local (You)" });
});
