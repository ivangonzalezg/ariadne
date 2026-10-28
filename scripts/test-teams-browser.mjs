import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Real manifest, MAIN/ISOLATED worlds, recorder, OPFS and FFmpeg, with a local
// Teams DOM/media fixture served under a supported origin. No Microsoft login.
const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "ariadne-teams-"));
const url = "https://teams.cloud.microsoft/v2/ariadne-fixture";
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
  const { id } = await browserSession.send("Extensions.loadUnpacked", { path: resolve(root) });
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${id}/`))
    ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ autoStart: true, captionMode: "hybrid" }));
  const fixture = await readFile(join(root, "tests/browser/teams-meeting.html"), "utf8");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://teams.cloud.microsoft/**", route => route.fulfill({ contentType: "text/html", body: fixture }));
  await page.goto(url); await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => window.__asterionDiagnostics?.getRemoteAudioSnapshot().recorder?.state === "recording");
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, url);
  const status = () => worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: "asterion:get-status" }), tabId);
  const until = async (read, condition, description) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await read(); if (condition(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}`);
  };
  const ready = await until(status, state => state.transcriptActive, "captions enabled during silence");
  assert.equal(ready.platform, "teams"); assert.equal(ready.captionMode, "dom"); assert.equal(ready.hasTranscript, false);
  const firstSession = ready.sessionId;
  await page.evaluate(() => fixture.speak("Ana", "Primera", "1"));
  await until(status, state => state.hasTranscript, "first caption durably saved");
  // Real user events must pause capture without an automatic toggle undoing it.
  await page.locator("#closed-captions-button").click();
  await until(status, state => state.captionState === "paused", "trusted CC pause");
  await page.locator("#closed-captions-button").click();
  await until(status, state => state.transcriptActive, "trusted CC resume");
  await page.locator("#microphone-button").click();
  await until(status, state => !state.micMuted, "microphone unmuted");
  await page.evaluate(() => {
    const panel = document.querySelector('[data-tid="closed-captions-renderer"]');
    panel.replaceWith(panel.cloneNode(true));
  });
  await page.waitForFunction(() => window.__asterionDiagnostics.getRemoteAudioSnapshot().recorder.committedChunks >= 3);
  await page.evaluate(() => {
    document.querySelector('[data-tid="closed-caption-text"]').textContent = "Primera completa";
    fixture.speak("Carlos", "Segunda", "2");
  });
  await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: "asterion:popup-stop" }), tabId);
  const history = () => worker.evaluate(async () => (await chrome.storage.local.get({ meetingHistory: [] })).meetingHistory);
  const entries = await until(history, entries => entries.some(entry => entry.sessionId === firstSession && entry.audioConversionStatus === "succeeded"), "MP3 and history publication");
  const first = entries.find(entry => entry.sessionId === firstSession);
  assert.equal(first.platform, "teams");
  assert.equal(first.recordingStatus, "complete"); assert.equal(first.transcriptStatus, "complete");
  const storagePage = await context.newPage();
  await storagePage.goto(`chrome-extension://${id}/src/history/history.html`);
  await storagePage.locator('.meeting-card').first().click();
  await storagePage.waitForFunction(() => document.querySelector('.detail-metadata')?.textContent.includes('Microsoft Teams'));
  const saved = await storagePage.evaluate(async folderName => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName);
    const transcript = JSON.parse(await (await (await directory.getFileHandle("transcripcion.json")).getFile()).text());
    const audioBytes = [...new Uint8Array(await (await (await directory.getFileHandle("audio-reunion.mp3")).getFile()).arrayBuffer())];
    const manifest = JSON.parse(await (await (await directory.getFileHandle("manifest.json")).getFile()).text());
    return { transcript, audioBytes, manifest };
  }, first.folderName);
  assert.deepEqual(saved.transcript.map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: "Ana", text: "Primera completa" }, { speaker: "Carlos", text: "Segunda" },
  ]);
  assert(saved.audioBytes.length > 0); assert(saved.manifest.hasAudioMp3); assert.equal(saved.manifest.platform, "teams");
  const decoded = await page.evaluate(async bytes => {
    const audio = await fixture.context.decodeAudioData(Uint8Array.from(bytes).buffer);
    const samples = audio.getChannelData(0);
    const amplitude = (frequency, start, length) => {
      const offset = Math.floor(start * audio.sampleRate), size = Math.floor(length * audio.sampleRate);
      let re = 0, im = 0;
      for (let i = 0; i < size; i++) {
        const value = samples[offset + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
        const phase = 2 * Math.PI * frequency * i / audio.sampleRate;
        re += value * Math.cos(phase); im += value * Math.sin(phase);
      }
      return 4 * Math.hypot(re, im) / size;
    };
    return { duration: audio.duration, remote: amplitude(440, 0.2, 0.4), muted: amplitude(880, 0.2, 0.4), local: amplitude(880, audio.duration - 0.6, 0.4) };
  }, saved.audioBytes);
  assert(decoded.remote > 0.03, `Remote tone present: ${JSON.stringify(decoded)}`);
  assert(decoded.muted < 0.002, `Muted mic excluded: ${JSON.stringify(decoded)}`);
  assert(decoded.local > 0.03, `Unmuted mic present: ${JSON.stringify(decoded)}`);
  // End a second call by leaving, then join again without reloading Teams.
  await page.locator("#hangup-button").click();
  await until(status, state => !state.inMeeting, "meeting leave");
  // Allow the detector to observe the gap before the next call.
  await page.waitForTimeout(1100);
  await page.evaluate(() => fixture.join());
  const second = await until(status, state => state.sessionId && state.sessionId !== firstSession && state.state === "recording", "second call in same tab");
  await page.evaluate(() => fixture.speak("María", "Nueva llamada", "3"));
  await until(status, state => state.hasTranscript, "second call captions");
  await page.locator("#hangup-button").click();
  await until(history, entries => entries.some(entry => entry.sessionId === second.sessionId), "automatic stop on leave");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, platform: "teams", captions: saved.transcript, decodedAudio: decoded,
    checks: ["real manifest and recorder", "DOM enforced for hybrid preference", "trusted CC pause/resume", "panel replacement without duplicates", "final revision flushed", "OPFS transcript and MP3", "remote/local audio and mute", "popup stop", "second call without reload", "automatic stop on leave"] }, null, 2));
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
