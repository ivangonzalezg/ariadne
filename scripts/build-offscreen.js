import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const wrapperDir = "node_modules/@ffmpeg/ffmpeg/dist/esm";
const coreDir = "node_modules/@ffmpeg/core/dist/esm";
const outputDir = "dist/ffmpeg";
const coreName = "ffmpeg-core.js";
const wasmName = "ffmpeg-core.wasm";

const localFfmpeg = {
  name: "local-ffmpeg",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]@ffmpeg[\\/]ffmpeg[\\/]dist[\\/]esm[\\/](const|worker)\.js$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      if (path.endsWith("const.js")) {
        const cdnDefault = /^export const CORE_VERSION = "[^"]+";\r?\nexport const CORE_URL = [^\r\n]+;\r?\n/m;
        assert.match(source, cdnDefault, "FFmpeg CDN default changed");
        return { contents: source.replace(cdnDefault, "") };
      }

      const constantsImport = 'import { CORE_URL, FFMessageType } from "./const.js";';
      const upstreamLoader = /const load = async \(\{ coreURL: _coreURL, wasmURL: _wasmURL, workerURL: _workerURL, \}\) => \{\s+const first = !ffmpeg;[\s\S]*?(?=    ffmpeg\.setLogger)/;
      assert.ok(source.includes(constantsImport), "FFmpeg worker constants import changed");
      assert.match(source, upstreamLoader, "FFmpeg worker loader changed");

      // The packaged single-threaded ESM core resolves its sibling WASM using import.meta.url.
      const localLoader = [
        "const load = async () => {",
        "    const first = !ffmpeg;",
        "    ffmpeg = await createFFmpegCore();",
        "",
      ].join("\n");
      return {
        contents: source
          .replace(constantsImport, 'import { FFMessageType } from "./const.js";\nimport createFFmpegCore from "./ffmpeg-core.js";')
          .replace(upstreamLoader, localLoader),
        resolveDir: wrapperDir,
      };
    });
  },
};

const sharedOptions = { bundle: true, format: "esm", write: false, metafile: true, plugins: [localFfmpeg] };
const [offscreen, worker, core] = await Promise.all([
  build({ ...sharedOptions, entryPoints: ["src/offscreen/offscreen.js"], outfile: "dist/offscreen.bundle.js" }),
  build({
    ...sharedOptions,
    entryPoints: [`${wrapperDir}/worker.js`],
    outfile: `${outputDir}/ffmpeg-worker.js`,
    external: ["./ffmpeg-core.js"],
  }),
  readFile(`${coreDir}/${coreName}`, "utf8"),
]);

for (const { metafile } of [offscreen, worker]) {
  assert.ok(
    Object.keys(metafile.inputs).some(path => path.endsWith(`${wrapperDir}/const.js`)),
    "FFmpeg constants moved outside the local build transform",
  );
}

const outputs = [...offscreen.outputFiles, ...worker.outputFiles];
for (const { path, text } of [...outputs, { path: coreName, text: core }]) {
  assert.doesNotMatch(text, /unpkg\.com/i, `Remote FFmpeg CDN reference in ${path}`);
}

await mkdir(outputDir, { recursive: true });
await Promise.all([
  ...outputs.map(({ path, contents }) => writeFile(path, contents)),
  writeFile(`${outputDir}/${coreName}`, core),
  copyFile(`${coreDir}/${wasmName}`, `${outputDir}/${wasmName}`),
  rm(`${outputDir}/const.js`, { force: true }),
  rm(`${outputDir}/errors.js`, { force: true }),
]);
