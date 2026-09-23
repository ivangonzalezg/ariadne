import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";

const DEST_DIR = "dist/ffmpeg";
const FILES = [
  { source: "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", destination: "ffmpeg-core.js" },
  { source: "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", destination: "ffmpeg-core.wasm" },
  { source: "node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js", destination: "ffmpeg-worker.js" },
  { source: "node_modules/@ffmpeg/ffmpeg/dist/esm/const.js", destination: "const.js" },
  { source: "node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js", destination: "errors.js" },
];

await mkdir(DEST_DIR, { recursive: true });
for (const { source: src, destination } of FILES) {
  if (!existsSync(src)) {
    throw new Error(`No se encontró ${src} - revisar el layout real de node_modules/@ffmpeg`);
  }
  await copyFile(src, `${DEST_DIR}/${destination}`);
}

console.log(`Copiados ${FILES.length} archivos de ffmpeg a ${DEST_DIR}/`);
