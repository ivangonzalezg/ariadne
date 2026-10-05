// Uses an isolated headless Chrome profile; no account, extension installation,
// browser dependency, or real meeting is needed for the WebRTC loopback test.
import { runExtensionIntegration } from "./extension-audio-integration.mjs";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "ariadne-audio-chrome-"));
const executable = process.env.CHROME_BIN ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "chromium");
const conversionBundle = await build({ entryPoints: [join(root, "tests/browser/conversion-runtime.js")], bundle: true, format: "esm", write: false });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/tests/browser/conversion.bundle.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(conversionBundle.outputFiles[0].contents); return;
  }
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(join(root, "src", "webrtc-bootstrap") + "/") &&
      !path.startsWith(join(root, "src", "lib") + "/") &&
      !path.startsWith(join(root, "tests", "browser") + "/") &&
      !path.startsWith(join(root, "dist", "ffmpeg") + "/")) {
    response.writeHead(404).end(); return;
  }
  try {
    const data = await readFile(path);
    response.setHeader("Content-Type", extname(path) === ".html" ? "text/html" : extname(path) === ".wasm" ? "application/wasm" : "text/javascript");
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
let chrome;
let socket;
async function launchChrome() {
  chrome = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  return await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chrome startup timed out")), 15000);
    chrome.on("error", (error) => { clearTimeout(timeout); reject(error); });
    chrome.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Chrome exited early (${code}): ${output.slice(-1000)}`)); });
    chrome.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
}
async function restartBrowser() {
  socket?.close();
  const previous = chrome;
  const exited = new Promise(resolve => previous.once("exit", resolve));
  previous.kill("SIGKILL");
  await exited;
  return launchChrome();
}
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const debuggerUrl = await launchChrome();
  const debuggerOrigin = new URL(debuggerUrl).origin.replace("ws:", "http:");
  const pages = await (await fetch(`${debuggerOrigin}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") console.error("Browser:", ...message.params.args.map((arg) => arg.value ?? arg.description));
      return;
    }
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    clearTimeout(handler.timer);
    if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
    else handler.resolve(message.result);
  };
  const command = (method, params = {}, timeout = 10000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  if (process.argv.includes("--integration-only")) {
    await runExtensionIntegration({ root, debuggerUrl, restartBrowser, origin: `http://127.0.0.1:${server.address().port}` });
  } else {
  await command("Runtime.enable");
  await command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/tests/browser/remote-audio.html${process.argv.includes("--hybrid") ? "?hybrid" : process.argv.includes("--playback-route") ? "?playback-route" : process.argv.includes("--disabled-receiver") ? "?disabled-receiver" : ""}` });
  let loaded = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await command("Runtime.evaluate", { expression: "typeof window.runRemoteAudioTest === 'function'", returnByValue: true });
    if (result.result.value) { loaded = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!loaded) throw new Error("Browser harness failed to load");
  console.log(process.argv.includes("--playback-route")
    ? "Chrome: testing captured page playback, duplicate prevention, fallback, 61s silence and repeated sessions."
    : process.argv.includes("--disabled-receiver")
    ? "Chrome: testing late join with disabled original receiver tracks."
    : "Chrome: testing actual WebRTC, late join, disabled receivers, remote analysis and decoded WebM (includes 61s acoustic mute).");
  const result = await command("Runtime.evaluate", { expression: "window.runRemoteAudioTest()", awaitPromise: true, returnByValue: true }, 360000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  if (!result.result.value?.ok) throw new Error("Browser test did not return success");
  console.log(JSON.stringify(result.result.value, null, 2));
  await runExtensionIntegration({ root, debuggerUrl, restartBrowser, origin: `http://127.0.0.1:${server.address().port}` });
  }
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill();
    await new Promise((resolve) => { chrome.once("exit", resolve); setTimeout(resolve, 3000).unref(); });
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
