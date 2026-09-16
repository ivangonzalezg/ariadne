import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";

const SRC_DIR = "node_modules/@ffmpeg/core/dist/esm";
const DEST_DIR = "dist/ffmpeg";
const FILES = ["ffmpeg-core.js", "ffmpeg-core.wasm"];

await mkdir(DEST_DIR, { recursive: true });
for (const file of FILES) {
  const src = `${SRC_DIR}/${file}`;
  if (!existsSync(src)) {
    throw new Error(`No se encontró ${src} — revisar el layout real de node_modules/@ffmpeg/core/dist`);
  }
  await copyFile(src, `${DEST_DIR}/${file}`);
}

console.log(`Copiados ${FILES.length} archivos de ffmpeg-core a ${DEST_DIR}/`);
