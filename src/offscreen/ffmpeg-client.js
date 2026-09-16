// src/offscreen/ffmpeg-client.js
import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpegInstance = null;
let loadPromise = null;
let queueTail = Promise.resolve();

async function getFfmpeg() {
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg();
    ffmpegInstance.on("log", ({ type, message }) => {
      console.log(`[Asterion ffmpeg:core] ${type}: ${message}`);
    });
    ffmpegInstance.on("progress", ({ progress, time }) => {
      console.log(`[Asterion ffmpeg:core] progress=${progress} time=${time}`);
    });
  }
  if (!loadPromise) {
    loadPromise = ffmpegInstance.load({
      classWorkerURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-worker.js"),
      coreURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.wasm"),
    });
  }
  await loadPromise;
  return ffmpegInstance;
}

let jobCounter = 0;

// Encola el trabajo detrás de cualquier otro ya en curso — nunca se corren dos
// exec() en simultáneo sobre la misma instancia de ffmpeg.
export function runFfmpegJob({ inputBytes, inputExt, outputExt, args }) {
  const result = queueTail.then(() => _runJob({ inputBytes, inputExt, outputExt, args }));
  // Si este job falla, la cola debe seguir viva para el siguiente — no propagar el
  // rechazo hacia queueTail.
  queueTail = result.catch(() => {});
  return result;
}

async function _runJob({ inputBytes, inputExt, outputExt, args }) {
  const jobId = ++jobCounter;
  const inputName = `input_${jobId}.${inputExt}`;
  const outputName = `output_${jobId}.${outputExt}`;
  const startedAt = Date.now();
  console.log(`[Asterion ffmpeg] job ${jobId}: iniciando (${inputBytes.byteLength} bytes de entrada)`);

  const ffmpeg = await getFfmpeg();
  try {
    await ffmpeg.writeFile(inputName, inputBytes);
    await ffmpeg.exec(["-i", inputName, ...args, outputName]);
    const outputData = await ffmpeg.readFile(outputName);
    if (!outputData || outputData.byteLength === 0) {
      throw new Error("ffmpeg produjo un archivo de salida vacío");
    }
    console.log(
      `[Asterion ffmpeg] job ${jobId}: terminado en ${Date.now() - startedAt}ms (${outputData.byteLength} bytes de salida)`
    );
    return outputData;
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
