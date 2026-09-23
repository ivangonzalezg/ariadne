import { beforeEach, describe, expect, it, vi } from "vitest";

const ffmpeg = vi.hoisted(() => ({ runFfmpegJob: vi.fn() }));

vi.mock("../offscreen/ffmpeg-client.js", () => ffmpeg);

import { SessionWriter } from "./session-writer.js";

class MemoryFileHandle {
  constructor(name) {
    this.name = name;
    this.bytes = new Uint8Array();
  }

  async createWritable() {
    return {
      write: async (value) => {
        if (typeof value === "string") {
          this.bytes = new TextEncoder().encode(value);
        } else if (value instanceof ArrayBuffer) {
          this.bytes = new Uint8Array(value);
        } else {
          this.bytes = new Uint8Array(value);
        }
      },
      close: async () => {},
    };
  }

  async getFile() {
    const bytes = this.bytes;
    return { arrayBuffer: async () => bytes.slice().buffer };
  }
}

class MemoryDirectoryHandle {
  constructor(name) {
    this.name = name;
    this.files = new Map();
    this.directories = new Map();
  }

  async getDirectoryHandle(name, { create } = {}) {
    if (!this.directories.has(name) && !create) throw new Error(`Missing directory: ${name}`);
    if (!this.directories.has(name)) this.directories.set(name, new MemoryDirectoryHandle(name));
    return this.directories.get(name);
  }

  async getFileHandle(name, { create } = {}) {
    if (!this.files.has(name) && !create) throw new Error(`Missing file: ${name}`);
    if (!this.files.has(name)) this.files.set(name, new MemoryFileHandle(name));
    return this.files.get(name);
  }
}

const waitFor = async (predicate) => {
  while (!predicate()) {
    await Promise.resolve();
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
    const root = new MemoryDirectoryHandle("root");
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { getDirectory: vi.fn().mockResolvedValue(root) },
    });
    ffmpeg.runFfmpegJob.mockReset();
  });

  it("finalizes and returns metadata without waiting for conversion", async () => {
    const conversion = deferred();
    ffmpeg.runFfmpegJob.mockReturnValue(conversion.promise);
    const writer = await createWriter({ audio: true, video: false });

    const metadata = await writer.finalize({ muteManifest: { intervals: [] } });

    expect(metadata).toMatchObject({ sessionId: "session-1", tabId: 7, hasVideo: false });
    await waitFor(() => ffmpeg.runFfmpegJob.mock.calls.length === 1);
    expect(manifestOf(writer).audioConversionStatus).toBe("pending");

    conversion.resolve(new Uint8Array([9]));
    await finishConversions(writer);
  });

  it("converts audio to mp3 before video to mp4 and records both successes", async () => {
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter();
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(ffmpeg.runFfmpegJob.mock.calls.map(([job]) => job.outputExt)).toEqual(["mp3", "mp4"]);
    expect(manifestOf(writer)).toMatchObject({
      audioConversionStatus: "succeeded",
      videoConversionStatus: "succeeded",
      hasAudioMp3: true,
      hasVideoMp4: true,
    });
  });

  it("continues with video conversion after an audio conversion failure", async () => {
    ffmpeg.runFfmpegJob.mockRejectedValueOnce(new Error("audio failed")).mockResolvedValueOnce(new Uint8Array([9]));
    const writer = await createWriter();
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(ffmpeg.runFfmpegJob.mock.calls.map(([job]) => job.outputExt)).toEqual(["mp3", "mp4"]);
    expect(manifestOf(writer)).toMatchObject({
      audioConversionStatus: "failed",
      videoConversionStatus: "succeeded",
      hasAudioMp3: false,
      hasVideoMp4: true,
    });
  });

  it("marks video conversion as skipped when no video stream was recorded", async () => {
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(ffmpeg.runFfmpegJob).toHaveBeenCalledTimes(1);
    expect(manifestOf(writer)).toMatchObject({
      audioConversionStatus: "succeeded",
      videoConversionStatus: "skipped",
      hasAudioMp3: true,
      hasVideoMp4: false,
    });
  });

  it("writes transcripcion.json with camelCase segments relative to startedAt", async () => {
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
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
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
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
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(writer.meetingHandle.files.has("transcripcion.json")).toBe(false);
  });

  it("uses the reconciled speaker label instead of the raw caption speaker when one is available", async () => {
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
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
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
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
});
