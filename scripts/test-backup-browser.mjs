import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobReader, TextReader, TextWriter, ZipReader, ZipWriter, Uint8ArrayWriter } from "@zip.js/zip.js";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "ariadne-backup-"));
const executablePath = process.env.CHROME_BIN ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "chromium");
let context;
try {
  const installation = join(temp, "destination");
  await mkdir(installation);
  for (const path of ["src", "dist", "icons", "_locales", "manifest.json"]) {
    await cp(join(root, path), join(installation, path), { recursive: true });
  }
  context = await chromium.launchPersistentContext(join(temp, "profile"), {
    executablePath, headless: true, ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--autoplay-policy=no-user-gesture-required"],
  });
  const browser = await context.browser().newBrowserCDPSession();
  const source = (await browser.send("Extensions.loadUnpacked", { path: root })).id;
  const target = (await browser.send("Extensions.loadUnpacked", { path: installation })).id;
  assert.notEqual(source, target);
  const settings = async id => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/src/settings/settings.html`);
    await page.locator("#backup-import:enabled").waitFor();
    return page;
  };
  const from = await settings(source);
  await from.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const put = async (folder, name, data) => {
      const file = await folder.getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      await writable.write(data);
      await writable.close();
    };
    const history = [];
    for (let n = 0; n < 201; n++) {
      const sessionId = `fixture-${n}`, folderName = `meeting-${n}`;
      const meeting = await root.getDirectoryHandle(folderName, { create: true });
      const meta = { sessionId, folderName, startedAt: n + 1, endedAt: n + 1000,
        durationMs: 999, meetingTitle: `Meeting ${n}`, platform: "meet", recordingStatus: "complete", hasTranscript: true };
      await put(meeting, "manifest.json", JSON.stringify(meta));
      await put(meeting, "transcripcion.json", JSON.stringify([{ speaker: "Ana", startTime: 0, endTime: 500,
        text: n === 200 ? "Unique meeting backup phrase" : `Transcript ${n}` }]));
      if (n !== 0) history.push(meta);
    }

    const meeting = await root.getDirectoryHandle("meeting-200");
    const audio = new AudioContext();
    await audio.resume();
    const tone = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    tone.connect(destination);
    tone.start();
    const recorder = new MediaRecorder(destination.stream, { mimeType: "audio/webm" });
    const data = new Promise(resolve => { recorder.ondataavailable = event => resolve(event.data); });
    const stop = new Promise(resolve => { recorder.onstop = resolve; });
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const paint = canvas.getContext("2d");
    const screen = canvas.captureStream(10);
    const video = new MediaRecorder(screen, { mimeType: "video/webm" });
    const videoData = new Promise(resolve => { video.ondataavailable = event => resolve(event.data); });
    const videoStop = new Promise(resolve => { video.onstop = resolve; });
    let frame = 0;
    const draw = setInterval(() => {
      paint.fillStyle = frame++ % 2 ? "green" : "blue";
      paint.fillRect(0, 0, 64, 64);
    }, 50);
    recorder.start();
    video.start();
    await new Promise(resolve => setTimeout(resolve, 700));
    recorder.stop();
    video.stop();
    await Promise.all([stop, videoStop]);
    clearInterval(draw);
    screen.getTracks().forEach(track => track.stop());
    const clip = await data;
    await audio.close();
    await put(meeting, "audio-reunion.webm", clip);
    await put(meeting, "video-reunion.webm", await videoData);
    const largeFile = await meeting.getFileHandle("video-segment-0.webm", { create: true });
    const largeWriter = await largeFile.createWritable();
    await largeWriter.truncate(8 * 1024 * 1024);
    await largeWriter.close();

    const { CaptureJournal } = await import("/src/storage/capture-journal.js");
    const journal = await CaptureJournal.open(meeting, {
      version: 1, sessionId: "fixture-200", folderName: "meeting-200", startedAt: 201, endedAt: 1200,
      meetingTitle: "Meeting 200", recordingStatus: "incomplete", platform: "meet", expectedSequences: { meeting: 2 },
      historyPublished: true, recoveryVersion: 2, recoveryRevision: 1, publishedRevision: 1,
      conversions: [{ sessionId: "fixture-200", stream: "meeting", state: "failed", published: true }],
      recoveryTasks: [{ sessionId: "fixture-200", stream: "publication", state: "succeeded", published: true }],
    });
    await journal.append("meeting", await clip.arrayBuffer(), { seq: 1, generation: 0, captureTs: 201 });
    const unreadable = await root.getDirectoryHandle("aaa-unreadable", { create: true });
    await put(unreadable, "capture-state.json", "{broken");
    const legacy = await root.getDirectoryHandle("aaa-legacy", { create: true });
    await put(legacy, "transcripcion.json", "[]");
    history.push({ sessionId: "missing", folderName: "missing", startedAt: 1 });
    const interrupted = await root.getDirectoryHandle("aaa-interrupted", { create: true });
    await put(interrupted, "manifest.json", JSON.stringify({ sessionId: "interrupted", startedAt: 1 }));
    await put(interrupted, "transcripcion.md", "Source read will fail");
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = async function () {
      const file = await getFile.call(this);
      if (this.name === "transcripcion.md") {
        file.stream = () => {
          let started = false;
          return new ReadableStream({
            pull(controller) {
              if (started) controller.error(new DOMException("Injected read failure", "NotReadableError"));
              else controller.enqueue(new Uint8Array([1]));
              started = true;
            },
          });
        };
      }
      return file;
    };
    await chrome.storage.local.set({ meetingHistory: history, autoStart: false });
    const scratch = await root.getDirectoryHandle("test-output", { create: true });
    const output = await scratch.getFileHandle("backup.zip", { create: true });
    if (typeof window.showSaveFilePicker !== "function") throw new Error("Native picker unavailable on this extension page");
    window.showSaveFilePicker = async () => output;
  });
  await from.locator("#backup-export").click();
  await from.locator("#backup-status").getByText("Backup saved. Meetings exported: 201. Skipped because they could not be read: 4.", { exact: true }).waitFor();
  const downloadStarted = from.waitForEvent("download");
  await from.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle("test-output");
    const file = await (await folder.getFileHandle("backup.zip")).getFile();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = "backup.zip";
    link.click();
  });
  const bytes = await readFile(await (await downloadStarted).path());
  assert(!bytes.includes(Buffer.from('"sessionId":"interrupted"')), "Omitted meeting data is absent from ZIP bytes");
  assert(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), "ZIP64 end record present");
  const to = await settings(target);
  await to.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle("new", { create: true });
    const file = await folder.getFileHandle("manifest.json", { create: true });
    const meta = { sessionId: "new", folderName: "new", startedAt: 5000, endedAt: 6000, meetingTitle: "New meeting" };
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(meta));
    await writable.close();
    await chrome.storage.local.set({ meetingHistory: [meta], autoStart: true });
  });
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${target}/`));
  const active = { "active-test": { tabId: 123 } };
  await worker.evaluate(active => chrome.storage.local.set({ activeRecordingSessions: active }), active);
  await to.locator("#backup-availability").getByText("Wait until recording and saving finish.", { exact: true }).waitFor();
  assert.equal(await to.locator("#backup-import").isDisabled(), true);
  await worker.evaluate(() => chrome.storage.local.set({ activeRecordingSessions: {} }));
  await to.locator("#backup-import:enabled").waitFor();

  await to.evaluate(() => chrome.runtime.sendMessage({ type: "asterion:recovery-pending", pending: true }));
  await to.locator("#backup-availability").getByText("Wait until meeting processing finishes.", { exact: true }).waitFor();
  assert.equal(await to.locator("#backup-export").isDisabled(), true);
  await to.evaluate(() => chrome.runtime.sendMessage({ type: "asterion:recovery-pending", pending: false }));
  await to.locator("#backup-export:enabled").waitFor();

  const choose = buffer => to.locator("#backup-file").setInputFiles({ name: "backup.zip", mimeType: "application/zip", buffer });
  const waitStatus = value => to.locator("#backup-status").getByText(value, { exact: true }).waitFor();
  const corrupted = Buffer.from(bytes);
  const offset = corrupted.indexOf(Buffer.from("Unique meeting backup phrase"));
  assert(offset > 0);
  corrupted[offset] ^= 1;
  await choose(corrupted);
  await waitStatus("Meetings to add: 201. Already in this library: 0.");
  await to.locator("#backup-confirm").click();
  await waitStatus("Could not complete the transfer. Check that the file is readable and there is enough space, then try again.");
  const currentLibrary = () => to.evaluate(async () => {
    const { meetingHistory, pendingMeetingBackupImport } = await chrome.storage.local.get(["meetingHistory", "pendingMeetingBackupImport"]);
    const root = await navigator.storage.getDirectory(), folders = [];
    for await (const name of root.keys()) folders.push(name);
    return { ids: meetingHistory.map(item => item.sessionId), pendingMeetingBackupImport, folders };
  });
  const unchanged = { ids: ["new"], pendingMeetingBackupImport: null, folders: ["new"] };
  assert.deepEqual(await currentLibrary(), unchanged);
  await to.locator("#backup-cancel").click();

  const zip = new ZipReader(new BlobReader(new Blob([bytes])), { useWebWorkers: false });
  const indexEntry = (await zip.getEntries()).find(entry => entry.filename === "ariadne-backup.json");
  const index = JSON.parse(await indexEntry.getData(new TextWriter()));
  await zip.close();
  index.version = 999;
  const incompatible = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  await incompatible.add("ariadne-backup.json", new TextReader(JSON.stringify(index)));
  await choose(Buffer.from(await incompatible.close()));
  await waitStatus("This backup version is unsupported.");

  const invalidPath = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  index.version = 1;
  index.meetings[0].files[0].path = "../manifest.json";
  await invalidPath.add("ariadne-backup.json", new TextReader(JSON.stringify(index)));
  await choose(Buffer.from(await invalidPath.close()));
  await waitStatus("This ZIP is not a valid Ariadne backup.");

  await choose(bytes);
  await waitStatus("Meetings to add: 201. Already in this library: 0.");
  await to.evaluate(() => {
    window.createWritableForTest = FileSystemFileHandle.prototype.createWritable;
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (++writes === 3) throw new DOMException("Injected full disk", "QuotaExceededError");
      return window.createWritableForTest.apply(this, args);
    };
  });
  await to.locator("#backup-confirm").click();
  await waitStatus("Free up disk space and try again.");
  assert.deepEqual(await currentLibrary(), unchanged);
  await to.evaluate(() => { FileSystemFileHandle.prototype.createWritable = window.createWritableForTest; });
  await to.locator("#backup-cancel").click();

  await choose(bytes);
  await waitStatus("Meetings to add: 201. Already in this library: 0.");
  await to.evaluate(() => {
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      if (++writes === 3) await new Promise(resolve => { window.continueWriteForTest = resolve; });
      return window.createWritableForTest.apply(this, args);
    };
  });
  await to.locator("#backup-confirm").click();
  await to.waitForFunction(() => Boolean(window.continueWriteForTest));
  await to.locator("#backup-cancel").click();
  await to.evaluate(() => {
    FileSystemFileHandle.prototype.createWritable = window.createWritableForTest;
    window.continueWriteForTest();
  });
  await waitStatus("Operation canceled.");
  assert.deepEqual(await currentLibrary(), unchanged);
  await to.locator("#backup-cancel").click();

  // The worker runs this reconciliation on startup after a tab or browser exits.
  await to.evaluate(async () => {
    const folder = "restore-12345678-1234-1234-1234-123456789abc";
    await chrome.storage.local.set({ pendingMeetingBackupImport: { folders: [folder] } });
    const root = await navigator.storage.getDirectory();
    await root.getDirectoryHandle(folder, { create: true });
    await chrome.runtime.sendMessage({ type: "asterion:recover-storage" });
  });
  assert.deepEqual(await currentLibrary(), unchanged);

  await choose(bytes);
  await waitStatus("Meetings to add: 201. Already in this library: 0.");
  await to.locator("#backup-confirm").click();
  await waitStatus("Meetings restored: 201. Already in this library: 0.");
  await choose(bytes);
  await waitStatus("Meetings to add: 0. Already in this library: 201.");
  await to.locator("#backup-confirm").click();
  await waitStatus("Meetings restored: 0. Already in this library: 201.");
  const restored = await to.evaluate(async () => {
    const { meetingHistory, autoStart } = await chrome.storage.local.get(["meetingHistory", "autoStart"]);
    const meta = meetingHistory.find(item => item.sessionId === "fixture-200");
    const root = await navigator.storage.getDirectory(), folder = await root.getDirectoryHandle(meta.folderName);
    const { CaptureJournal } = await import("/src/storage/capture-journal.js");
    const journal = await CaptureJournal.open(folder);
    return { count: meetingHistory.length, autoStart, first: meetingHistory[0].sessionId, meta,
      recordingStatus: journal.state.recordingStatus, gaps: journal.snapshot("meeting").gaps,
      largeFileSize: (await (await folder.getFileHandle("video-segment-0.webm")).getFile()).size };
  });
  assert.equal(restored.count, 202);
  assert.equal(restored.autoStart, true);
  assert.equal(restored.first, "new");
  assert.equal(restored.recordingStatus, "incomplete");
  assert.deepEqual(restored.gaps, [2]);
  assert.equal(restored.largeFileSize, 8 * 1024 * 1024);

  const history = await context.newPage();
  await history.goto(`chrome-extension://${target}/src/history/history.html?sessionId=fixture-200`);
  await history.locator(".transcript-spoken").filter({ hasText: "Unique meeting backup phrase" }).waitFor();
  await history.getByRole("tab", { name: "Audio" }).click();
  await history.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
  await history.getByRole("tab", { name: "Video" }).click();
  await history.waitForFunction(() => document.querySelector("video")?.readyState >= 1);
  await history.locator("#search-input").fill("Unique meeting backup phrase");
  await history.waitForFunction(() => document.querySelectorAll(".meeting-card").length === 1);
  assert.equal(await history.locator(".meeting-card").getAttribute("data-meeting-id"), "fixture-200");
  await history.evaluate(() => {
    chrome.downloads.download = async ({ url, filename }, callback) => {
      const file = await (await fetch(url)).blob();
      window.restoredDownload = { filename, size: file.size };
      callback(123);
    };
  });
  await history.getByRole("button", { name: "Download", exact: true }).click();
  await history.waitForFunction(() => window.restoredDownload?.size > 0);
  assert.equal(await history.evaluate(() => window.restoredDownload.filename), "meeting-200-video.webm");

  await history.locator(".recovery-retry").click();
  await history.waitForFunction(async () => {
    const { meetingHistory } = await chrome.storage.local.get({ meetingHistory: [] });
    const restored = meetingHistory.find(entry => entry.sessionId === "fixture-200");
    return restored?.hasAudioMp3 && !restored.processing?.pending;
  });
  assert.equal((await currentLibrary()).ids.length, 202, "A recovery publication keeps all imported meetings");

  const other = await settings(target);
  await to.evaluate(() => {
    window.libraryLock = navigator.locks.request("ariadne-meeting-library", async () => {
      await new Promise(resolve => { window.unlockLibrary = resolve; });
    });
  });
  await to.waitForFunction(() => Boolean(window.unlockLibrary));
  await other.locator("#backup-availability").getByText("A backup or restore is in progress. Try again when it finishes.", { exact: true }).waitFor();
  assert.equal(await other.locator("#backup-export").isDisabled(), true);
  const busyStart = await other.evaluate(() => chrome.runtime.sendMessage({
    type: "asterion:session-starting", sessionId: "blocked-recording", meetingTitle: "Blocked",
  }));
  assert.equal(busyStart.code, "BACKUP_BUSY");
  await to.evaluate(async () => { window.unlockLibrary(); await window.libraryLock; });
  await other.locator("#backup-export:enabled").waitFor();
  console.log("Backup verified across extension IDs: 201 meetings, ZIP64, CRC rollback, invalid paths and versions, full disk, cancellation, interrupted import cleanup, duplicates, audio and video, downloads, recovery and library lock.");
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
