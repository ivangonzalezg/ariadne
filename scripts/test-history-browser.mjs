import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const profile = await mkdtemp(join(tmpdir(), "ariadne-history-chrome-"));
const executable = process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "chromium");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root)) { response.writeHead(404).end(); return; }
  try {
    let content = await readFile(path);
    if (pathname === "/src/settings/settings.html") content = Buffer.from(content.toString().replace('src="settings.js"', 'src="/tests/browser/settings-runtime.js"'));
    if (pathname === "/src/history/history.html") content = Buffer.from(content.toString().replace('src="history.js"', 'src="/tests/browser/history-runtime.js"'));
    response.setHeader("Content-Type", ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream'); response.end(content);
  } catch { response.writeHead(404).end(); }
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
  let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timeout`)); }, 45000);
    pending.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await call("Page.enable", {});
  await call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const results = [];
  for (const locale of ['en', 'es', 'fr']) for (const theme of ['dark', 'light']) {
    const reduced = theme === 'light';
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
    await call('Page.navigate', { url: `${url}/src/history/history.html?locale=${locale}&theme=${theme}` });
    await new Promise(resolve => setTimeout(resolve, 200));
    const result = await call("Runtime.evaluate", { expression: `(async () => { const deadline = Date.now() + 12000; while (!window.runHistoryTest) { if (Date.now() > deadline) throw new Error('Harness did not load'); await new Promise(resolve => setTimeout(resolve, 20)); } return await window.runHistoryTest(); })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    if (!result.result?.value?.passed) throw new Error('History browser verification failed');
    results.push(result.result.value);
    if (process.env.HISTORY_SCREENSHOT_DIR) {
      await call('Runtime.evaluate', { expression: 'window.previewHistory()', awaitPromise: true });
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(process.env.HISTORY_SCREENSHOT_DIR, `history-${locale}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  for (const locale of ['en', 'es', 'fr']) for (const theme of ['dark', 'light']) {
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: theme === 'light' ? 'reduce' : 'no-preference' }] });
    await call('Page.navigate', { url: `${url}/src/settings/settings.html?locale=${locale}&theme=${theme}` });
    await new Promise(resolve => setTimeout(resolve, 200));
    const result = await call('Runtime.evaluate', { expression: `(async()=>{const end=Date.now()+8000;while(!window.runSettingsTest){if(Date.now()>end)throw Error('Settings did not load');await new Promise(r=>setTimeout(r,20));}return await window.runSettingsTest();})()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    results.push(result.result.value);
    await call('Runtime.evaluate', { expression: 'window.prepareSettingsKeyboard()' });
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    const keyboard = await call('Runtime.evaluate', { expression: 'window.finishSettingsKeyboard()', awaitPromise: true, returnByValue: true });
    if (keyboard.exceptionDetails || keyboard.result.value !== true) throw new Error(JSON.stringify(keyboard));
    if (process.env.HISTORY_SCREENSHOT_DIR) {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(process.env.HISTORY_SCREENSHOT_DIR, `settings-${locale}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  socket?.close(); chrome?.kill(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
