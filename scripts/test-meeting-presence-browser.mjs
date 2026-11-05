// Real extension, recorders and OPFS in an isolated Chrome profile; no Meet login.
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "ariadne-presence-"));
const url = "https://meet.google.com/meet/presence-fixture";
const executablePath = process.env.CHROME_BIN ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "chromium");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--autoplay-policy=no-user-gesture-required"],
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  const { id } = await browserSession.send("Extensions.loadUnpacked", { path: root });
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${id}/`))
    ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ autoStart: true }));
  const html = await readFile(join(root, "tests/browser/extension-meeting.html"), "utf8");
  const fixture = await readFile(join(root, "tests/browser/extension-meeting.js"), "utf8");
  const page = await context.newPage();
  await page.route("https://meet.google.com/**", route => route.fulfill({
    contentType: route.request().url().endsWith(".js") ? "text/javascript" : "text/html",
    body: route.request().url().endsWith(".js") ? fixture : html,
  }));
  await page.goto(url);
  await page.waitForFunction(() => window.__asterionDiagnostics?.getRemoteAudioSnapshot().recorder?.state === "recording");
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, url);
  const status = () => worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: "asterion:get-status" }), tabId);
  const until = async (read, condition, description) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const value = await read(); if (condition(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}`);
  };
  const sessionId = (await status()).sessionId;
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<button jsname="RrG0hf" aria-pressed="true" aria-controls="captions">CC</button><div role="region" id="captions"></div>');
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
    let frame = 0;
    window.drawTimer = setInterval(() => {
      const paint = canvas.getContext("2d"); paint.fillStyle = frame++ % 2 ? "green" : "blue"; paint.fillRect(0, 0, 64, 64);
    }, 100);
    window.displayStream = canvas.captureStream(10);
    navigator.mediaDevices.getDisplayMedia = async () => window.displayStream;
    const video = document.createElement("button"); video.id = "fixture-video"; video.setAttribute("data-asterion-enable-video", "");
    document.body.append(video);
  });
  await until(status, value => value.transcriptActive, "captions ready");
  await page.locator("#fixture-video").click();
  await until(status, value => value.videoEnabled, "video enabled");
  const storage = () => page.evaluate(() => window.__asterionDiagnostics.getStorageSnapshot());
  const before = await until(storage, value => value.streams?.video?.confirmedSequences.length > 0, "audio and video saved");
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.evaluate(cycle => {
      document.body.setAttribute("aria-hidden", "true"); document.body.setAttribute("inert", "");
      document.getElementById("captions").insertAdjacentHTML("beforeend", `<div class="nMcdL bj4p3b"><span class="NWpY1d">Ana</span><span class="ygicle VbkSUe">Modal ${cycle}</span></div>`);
    }, cycle);
    // Longer than the exit deadline: modal isolation must never trigger it.
    await new Promise(resolve => setTimeout(resolve, 4200));
    assert.equal((await status()).sessionId, sessionId);
    assert.equal((await status()).videoEnabled, true);
    assert.equal(await page.evaluate(() => window.displayStream.getVideoTracks()[0].readyState), "live");
    const current = await storage();
    assert(current.streams.meeting.confirmedSequences.length > before.streams.meeting.confirmedSequences.length);
    assert(current.streams.video.confirmedSequences.length > before.streams.video.confirmedSequences.length);
    await page.evaluate(() => { document.body.removeAttribute("aria-hidden"); document.body.removeAttribute("inert"); });
  }
  const snapshot = await page.evaluate(() => window.__asterionDiagnostics.getRemoteAudioSnapshot());
  assert.equal(snapshot.recorder.generation, 0);
  assert.equal((await storage()).recordingStatus, "recording");
  await page.evaluate(() => { document.querySelector("i").hidden = true; });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.evaluate(() => { document.querySelector("i").hidden = false; });
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal((await status()).sessionId, sessionId);
  await page.evaluate(() => {
    const icon = [...document.querySelectorAll("i")].find(icon => icon.textContent === "call_end");
    const hangup = document.createElement("button");
    hangup.id = "fixture-hangup";
    icon.replaceWith(hangup);
    hangup.append(icon);
    let hideOnNextClick = true;
    hangup.addEventListener("click", event => {
      if (!event.isTrusted) {
        hangup.remove();
        setTimeout(() => document.body.append(hangup), 500);
        return;
      }
      if (hideOnNextClick) {
        hideOnNextClick = false;
        hangup.hidden = true;
        setTimeout(() => { hangup.hidden = false; }, 500);
        return;
      }
      const dialog = document.createElement("dialog");
      dialog.innerHTML = '<button id="fixture-cancel-leave">Cancel</button><button id="fixture-confirm-leave">Leave</button>';
      document.body.append(dialog);
      dialog.showModal();
      hangup.remove();
      dialog.querySelector("#fixture-cancel-leave").onclick = () => {
        document.body.append(hangup);
        dialog.remove();
      };
      dialog.querySelector("#fixture-confirm-leave").onclick = () => {
        window.confirmedLeaveAt = Date.now();
        dialog.remove();
      };
    });
    hangup.click();
  });
  await page.locator("#fixture-hangup i").click();
  await page.locator("#fixture-hangup i").waitFor();
  assert.equal((await status()).sessionId, sessionId, "A visibility-only change after a trusted click keeps recording");
  await page.locator("#fixture-hangup i").click();
  await new Promise(resolve => setTimeout(resolve, 3400));
  assert.equal((await status()).sessionId, sessionId, "The confirmation dialog preserves the recording");
  assert.equal((await status()).state, "video-enabled");
  await page.locator("#fixture-cancel-leave").click();
  assert.equal((await status()).sessionId, sessionId, "Cancel retains the same session");
  await page.locator("#fixture-hangup").press("Enter");
  await new Promise(resolve => setTimeout(resolve, 3400));
  await page.locator("#fixture-confirm-leave").click();
  const history = () => worker.evaluate(async () => (await chrome.storage.local.get({ meetingHistory: [] })).meetingHistory);
  const entries = await until(history, entries => entries.some(entry => entry.sessionId === sessionId && entry.diskSize), "session finalized with a persisted size");
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.cleanup?.status, "complete", "A complete recording is compacted automatically");
  const confirmedAt = await page.evaluate(() => window.confirmedLeaveAt);
  assert(entry.endedAt >= confirmedAt && entry.endedAt - confirmedAt < 3000, "A confirmed hangup bypasses the absence timer");
  const storagePage = await context.newPage();
  await storagePage.goto(`chrome-extension://${id}/src/history/history.html`);
  const totals = await storagePage.evaluate(async ({ folderName, sessionId }) => {
    const { directorySize } = await import("/src/storage/meeting-directory-size.js");
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName);
    const { meetingHistory } = await chrome.storage.local.get({ meetingHistory: [] });
    const files = [];
    for await (const item of directory.values()) files.push(item.name);
    return { actual: await directorySize(directory), saved: meetingHistory.find(entry => entry.sessionId === sessionId).diskSize.bytes, files };
  }, { folderName: entries.find(entry => entry.sessionId === sessionId).folderName, sessionId });
  assert.equal(totals.saved, totals.actual, "The saved total includes the last checkpoint");
  for (const name of ["audio-reunion.mp3", "video-reunion.mp4", "transcripcion.json", "manifest.json", "capture-state.json"]) {
    assert(totals.files.includes(name), `Final artifact retained: ${name}`);
  }
  assert(!totals.files.some(name => /-records$|\.webm$/.test(name)), "Temporary journals and duplicate WebM files are gone");
  await storagePage.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.measurementRequests = 0;
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.type === "asterion:measure-meeting-size") window.measurementRequests++;
      return send(message, ...args);
    };
  });
  await storagePage.reload();
  await storagePage.waitForFunction(() => document.querySelector(".meeting-size")?.textContent.endsWith("on disk"));
  assert.equal(await storagePage.evaluate(() => window.measurementRequests), 0);
  const transcript = await storagePage.evaluate(async folderName => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName);
    return JSON.parse(await (await (await directory.getFileHandle("transcripcion.json")).getFile()).text());
  }, entry.folderName);
  assert.deepEqual(transcript.map(segment => segment.text), ["Modal 0", "Modal 1"]);
  assert.equal(entry.recordingStatus, "complete");
  assert.equal(entry.hasVideo, true);
  await storagePage.locator(".meeting-card").click();
  await storagePage.getByRole("tab", { name: "Audio" }).click();
  await storagePage.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
  await storagePage.getByRole("tab", { name: "Video" }).click();
  await storagePage.waitForFunction(() => document.querySelector("video")?.readyState >= 1);
  await storagePage.evaluate(() => {
    chrome.downloads.download = async ({ filename, url }, callback) => {
      const file = await (await fetch(url)).blob();
      window.cleanedDownload = { filename, size: file.size };
      callback(123);
    };
  });
  await storagePage.getByRole("button", { name: "Download", exact: true }).click();
  await storagePage.waitForFunction(() => window.cleanedDownload?.filename.endsWith(".mp4") && window.cleanedDownload.size > 0);
  await storagePage.locator("#search-input").fill("Modal 1");
  await storagePage.waitForFunction(() => document.querySelectorAll(".meeting-card").length === 1 &&
    document.querySelector("#meetings-list").getAttribute("aria-busy") === "false");

  console.log(JSON.stringify({ meetingPresence: { ok: true, sessionId, checks: ["prolonged repeated modals", "durable audio and video", "captions during modal", "brief control absence", "synthetic click", "trusted click and keyboard", "long confirmation and cancellation", "one history entry"] } }, null, 2));
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
