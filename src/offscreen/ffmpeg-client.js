import { FFmpeg } from "@ffmpeg/ffmpeg";
import { debugEvent } from "../shared/debug-log.js";

let queueTail = Promise.resolve();
let jobCounter = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed(operation, ms, label) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function runFfmpegJob(job) {
  return runWithRetries(job);
}

async function runWithRetries(job) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return await runFfmpegAttempt(job); }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (job.signal?.aborted) throw lastError;
      if (lastError.message.includes("ASSET_UNAVAILABLE") || lastError.message.includes("INPUT_INVALID")) throw lastError;
      debugEvent("conversion-retry", { attempt: attempt + 1, message: lastError.message, exhausted: attempt === 9 });
      if (attempt < 9) await delay((180 + 8 ** ((attempt + 1) % 6 - 1)) * 1000);
    }
  }
  throw lastError;
}

export function runFfmpegAttempt(job) {
  const result = queueTail.then(() => runAttempt(job));
  queueTail = result.catch(() => {});
  return result;
}

async function runAttempt({ signal, inputBytes, inputs = inputBytes ? [inputBytes] : [], inputExt, outputExt, args = [], normalizeAvStreams = false, onProgress }) {
  if (signal?.aborted) throw new Error("JOB_TIMEOUT");
  if (!inputs.length || inputs.some((input) => !input?.byteLength)) throw new Error("INPUT_INVALID");
  const id = ++jobCounter;
  const ffmpeg = new FFmpeg();
  const files = inputs.map((_, index) => `input_${id}_${index}.${inputExt}`);
  const output = `output_${id}.${outputExt}`;
  const list = `segments_${id}.txt`;
  const process = async () => {
    try {
      await timed(ffmpeg.load({
        classWorkerURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-worker.js"),
        coreURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.wasm"),
      }), 180000, "LOAD");
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes("TIMEOUT")) throw error;
      throw new Error(`ASSET_UNAVAILABLE: ${message}`);
    }
    ffmpeg.on("log", ({ message }) => debugEvent("conversion-core", { jobId: id, message }));
    ffmpeg.on("progress", ({ time }) => onProgress?.(time / 1000));
    for (let index = 0; index < files.length; index++) await timed(ffmpeg.writeFile(files[index], inputs[index].slice()), 120000, "WRITE");
    let orderedFiles = files;
    if (normalizeAvStreams && files.length > 1) {
      // Recorder generations can emit audio and video in a different stream
      // order. Concat matches positions, so remux each segment consistently.
      orderedFiles = [];
      for (let index = 0; index < files.length; index++) {
        const normalized = `ordered_${id}_${index}.${inputExt}`;
        const code = await timed(ffmpeg.exec(["-i", files[index], "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", normalized]), 1200000, "RUN");
        if (code !== undefined && code !== 0) throw new Error(`FFmpeg exited ${code}`);
        orderedFiles.push(normalized);
      }
    }
    let inputArgs = ["-i", orderedFiles[0]];
    if (files.length > 1) {
      await timed(ffmpeg.writeFile(list, new TextEncoder().encode(orderedFiles.map((file) => `file '${file}'`).join("\n"))), 120000, "WRITE");
      inputArgs = ["-f", "concat", "-safe", "0", "-i", list];
    }
    const exitCode = await timed(ffmpeg.exec([...inputArgs, ...args, output]), 1200000, "RUN");
    if (exitCode !== undefined && exitCode !== 0) throw new Error(`FFmpeg exited ${exitCode}`);
    const result = await timed(ffmpeg.readFile(output), 120000, "READ");
    if (!result?.byteLength) throw new Error("Empty conversion output");
    return result;
  };
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const onAbort = () => { ffmpeg.terminate?.(); rejectAborted(new Error("JOB_TIMEOUT")); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try { return await timed(Promise.race([process(), aborted]), 1680000, "JOB"); }
  finally {
    signal?.removeEventListener("abort", onAbort);
    // terminate rejects pending worker operations; a timed-out attempt can
    // neither publish output nor overlap the next job on the same runtime.
    ffmpeg.terminate?.();
  }
}
