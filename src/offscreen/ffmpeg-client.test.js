import { beforeEach, describe, expect, it, vi } from "vitest";

const ffmpegState = vi.hoisted(() => ({
  events: [],
  activeExecutions: 0,
  maximumConcurrentExecutions: 0,
  execResolvers: [],
  loadConfig: null,
  commands: [],
  files: new Map(),
}));

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    on() {}

    async load(config) {
      ffmpegState.loadConfig = config;
    }

    async writeFile(name, bytes) { ffmpegState.files.set(name, bytes); }

    async exec(args) {
      ffmpegState.commands.push(args);
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
    ffmpegState.loadConfig = null;
    ffmpegState.commands = [];
    ffmpegState.files = new Map();
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
    expect(ffmpegState.loadConfig).toEqual({
      classWorkerURL: "dist/ffmpeg/ffmpeg-worker.js",
      coreURL: "dist/ffmpeg/ffmpeg-core.js",
      wasmURL: "dist/ffmpeg/ffmpeg-core.wasm",
    });
  });

  it("remuxes audiovisual generations into consistent stream positions before concat", async () => {
    const { runFfmpegAttempt } = await import("./ffmpeg-client.js");
    const result = runFfmpegAttempt({ inputs: [new Uint8Array([1]), new Uint8Array([2])], inputExt: "webm", outputExt: "mp4", normalizeAvStreams: true });
    for (let index = 0; index < 3; index++) {
      await waitFor(() => ffmpegState.commands.length === index + 1);
      if (index < 2) expect(ffmpegState.commands[index].slice(2, -1)).toEqual(["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"]);
      else {
        expect(ffmpegState.commands[index].slice(0, 4)).toEqual(["-f", "concat", "-safe", "0"]);
        const list = new TextDecoder().decode(ffmpegState.files.get(ffmpegState.commands[index][5]));
        expect(list.split("\n")).toEqual(ffmpegState.commands.slice(0, 2).map((command) => `file '${command.at(-1)}'`));
      }
      ffmpegState.execResolvers.shift()();
    }
    await result;
  });
});
