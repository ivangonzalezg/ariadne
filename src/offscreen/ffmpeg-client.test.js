import { beforeEach, describe, expect, it, vi } from "vitest";

const ffmpegState = vi.hoisted(() => ({
  events: [],
  activeExecutions: 0,
  maximumConcurrentExecutions: 0,
  execResolvers: [],
}));

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    async load() {}

    async writeFile() {}

    async exec() {
      ffmpegState.events.push("enter");
      ffmpegState.activeExecutions += 1;
      ffmpegState.maximumConcurrentExecutions = Math.max(
        ffmpegState.maximumConcurrentExecutions,
        ffmpegState.activeExecutions
      );
      await new Promise((resolve) => ffmpegState.execResolvers.push(resolve));
      ffmpegState.activeExecutions -= 1;
      ffmpegState.events.push("exit");
    }

    async readFile() {
      return new Uint8Array([1]);
    }

    async deleteFile() {}
  },
}));

const waitFor = async (predicate) => {
  while (!predicate()) {
    await Promise.resolve();
  }
};

describe("runFfmpegJob", () => {
  beforeEach(() => {
    ffmpegState.events = [];
    ffmpegState.activeExecutions = 0;
    ffmpegState.maximumConcurrentExecutions = 0;
    ffmpegState.execResolvers = [];
    globalThis.chrome = { runtime: { getURL: (path) => path } };
  });

  it("serializes jobs so two FFmpeg exec calls never overlap", async () => {
    const { runFfmpegJob } = await import("./ffmpeg-client.js");
    const first = runFfmpegJob({
      inputBytes: new Uint8Array([1]),
      inputExt: "webm",
      outputExt: "mp3",
      args: ["-vn"],
    });
    const second = runFfmpegJob({
      inputBytes: new Uint8Array([2]),
      inputExt: "webm",
      outputExt: "mp4",
      args: [],
    });

    await waitFor(() => ffmpegState.events.length === 1);
    expect(ffmpegState.events).toEqual(["enter"]);
    expect(ffmpegState.maximumConcurrentExecutions).toBe(1);

    ffmpegState.execResolvers.shift()();
    await waitFor(() => ffmpegState.events.length === 3);
    expect(ffmpegState.events).toEqual(["enter", "exit", "enter"]);
    expect(ffmpegState.maximumConcurrentExecutions).toBe(1);

    ffmpegState.execResolvers.shift()();
    await Promise.all([first, second]);

    expect(ffmpegState.events).toEqual(["enter", "exit", "enter", "exit"]);
    expect(ffmpegState.maximumConcurrentExecutions).toBe(1);
  });
});
