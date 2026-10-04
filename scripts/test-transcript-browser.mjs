import { runExtensionIntegration } from "./extension-audio-integration.mjs";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const profile = await mkdtemp(join(tmpdir(), "ariadne-caption-chrome-"));
const executable = process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "chromium");
const bundle = await build({ entryPoints: [new URL("../tests/browser/transcript-runtime.js", import.meta.url).pathname], bundle: true, write: false, format: "iife" });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname.startsWith("/tests/browser/")) {
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(join(root, "tests", "browser") + "/")) { response.writeHead(404).end(); return; }
    try { response.setHeader("Content-Type", extname(path) === ".html" ? "text/html" : "text/javascript"); response.end(await readFile(path)); }
    catch { response.writeHead(404).end(); }
    return;
  }
  if (request.url === "/runtime.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); }
  else response.end('<!doctype html><html><body><script src="/runtime.js"></script></body></html>');
});
let chrome, socket;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  chrome = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const debuggerUrl = await new Promise((resolve, reject) => {
    let output = ""; const timer = setTimeout(() => reject(new Error("Chrome startup timeout")), 15000);
    chrome.on("error", error => { clearTimeout(timer); reject(error); });
    chrome.on("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${output.slice(-500)}`)); });
    chrome.stderr.on("data", chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const pages = await (await fetch(`${new URL(debuggerUrl).origin.replace("ws:", "http:")}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let loaded; let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.method === "Page.loadEventFired") loaded?.(); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timeout`)); }, 45000);
    pending.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await call("Page.enable", {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Page load timeout")), 10000);
    loaded = () => { clearTimeout(timer); resolve(); };
    call("Page.navigate", { url }).catch(error => { clearTimeout(timer); reject(error); });
  });
  const result = await call("Runtime.evaluate", { expression: `(async () => { const deadline = Date.now() + 10000; while (!window.runTranscriptTest) { if (Date.now() > deadline) throw new Error('Harness did not load'); await new Promise(resolve => setTimeout(resolve, 20)); } return await window.runTranscriptTest(); })()`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  if (!result.result?.value?.passed) throw new Error("Browser verification failed");
  const position = (await call("Runtime.evaluate", { expression: "window.prepareTrustedCaptionToggle()", returnByValue: true })).result.value;
  const click = async () => {
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
  };
  await click();
  const paused = await call("Runtime.evaluate", { expression: `(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));return {state:window.pauseStatus.state,pressed:document.querySelector('button[jsname="RrG0hf"]').getAttribute('aria-pressed')};})()`, awaitPromise: true, returnByValue: true });
  if (paused.result.value.state !== "paused" || paused.result.value.pressed !== "false") throw new Error("Trusted CC disable was not respected");
  await click();
  const resumed = await call("Runtime.evaluate", { expression: `(async()=>{await new Promise(resolve=>setTimeout(resolve,600));window.stopPauseObserver();return window.pauseStatus.state;})()`, awaitPromise: true, returnByValue: true });
  if (resumed.result.value !== "active") throw new Error("Manual CC enable did not resume capture");
  result.result.value.checks.push("Trusted browser clicks: manual CC pause and resume");
  console.log(JSON.stringify(result.result.value, null, 2));
  await runExtensionIntegration({ root, debuggerUrl, origin: url });
} finally {
  socket?.close(); chrome?.kill(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
