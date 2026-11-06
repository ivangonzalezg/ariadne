import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../shared/i18n/locales/en.json";

const page = readFileSync("src/history/history.html", "utf8");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const meeting = sessionId => ({ sessionId, folderName: `folder-${sessionId}`, meetingTitle: `Meeting ${sessionId}`,
  startedAt: Date.now(), endedAt: Date.now(), hasTranscript: false, hasVideo: false, recordingStatus: "complete",
  audioConversionStatus: "skipped", transcriptExportStatus: "skipped", videoConversionStatus: "skipped" });
let changed;
const documentListeners = [];
async function setup({ entries = [], target = "target", recovery = Promise.resolve({}), format = "txt" } = {}) {
  vi.resetModules(); vi.useFakeTimers();
  window.history.replaceState({}, "", `/?sessionId=${encodeURIComponent(target)}`);
  document.body.innerHTML = new DOMParser().parseFromString(page, "text/html").body.innerHTML;
  const addListener = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, callback, options) => {
    documentListeners.push([type, callback]); addListener(type, callback, options);
  });
  globalThis.chrome = {
    runtime: { getURL: path => path, sendMessage: vi.fn(message => message.type === "asterion:recover-storage" ? recovery : Promise.resolve({})) },
    storage: { local: { get: (defaults, callback) => callback({ ...defaults, meetingHistory: entries, transcriptDownloadFormat: format }) },
      onChanged: { addListener: callback => { changed = callback; } } },
  };
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => en }));
  await import("./history.js"); await flush();
}
function publish(entries) { changed({ meetingHistory: { newValue: entries } }, "local"); }
const selectedId = () => document.querySelector(".meeting-card.is-selected")?.dataset.meetingId;
afterEach(() => {
  for (const [type, callback] of documentListeners.splice(0)) document.removeEventListener(type, callback);
  document.body.replaceChildren(); window.history.replaceState({}, "", "/");
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); delete globalThis.chrome; delete globalThis.fetch;
});

describe("history session links", () => {
  it("restores the saved transcript format on initial history loading", async () => {
    const { MemoryDirectoryHandle } = await import('../../tests/helpers/memory-opfs.js');
    const root = new MemoryDirectoryHandle('root');
    const folder = await root.getDirectoryHandle('folder-target', { create: true });
    const writable = await (await folder.getFileHandle('transcripcion.json', { create: true })).createWritable();
    await writable.write(JSON.stringify([{ speaker: 'Ana', startTime: 0, text: 'Saved transcript' }])); await writable.close();
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => root } });
    await setup({ entries: [{ ...meeting('target'), hasTranscript: true }], format: 'md' });
    await flush();
    expect(document.querySelector('.detail-footer .transcript-format').value).toBe('md');
    expect(document.querySelector('.detail-file-name').textContent).toBe('meeting-target-transcript.md');
  });
  it("selects and opens the requested recording instead of the newest", async () => {
    await setup({ entries: [meeting("newest"), meeting("target")] });
    expect(selectedId()).toBe("target");
    expect(document.querySelector(".detail-title").textContent).toBe("Meeting target");
    expect(document.activeElement.dataset.meetingId).not.toBe("target");
    expect(document.querySelector('.meeting-card.is-selected').hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector('[role="tab"][id$="-manifest-tab"]')).toBeNull();
    expect([...document.querySelectorAll('.file-chip')].some(chip => chip.textContent.trim().endsWith(en['common.manifest']))).toBe(false);
  });

  it("waits for initial publication and selects it when storage changes", async () => {
    const recovery = deferred(); await setup({ entries: [meeting("other")], recovery: recovery.promise });
    expect(document.querySelector(".detail-placeholder").textContent).toBe(en["history.linkedMeetingWaiting"]);
    expect(selectedId()).toBeUndefined();
    publish([meeting("other"), meeting("target")]); await flush();
    expect(selectedId()).toBe("target");
    recovery.resolve({}); await flush(); expect(selectedId()).toBe("target");
  });

  it("reports an unavailable target without selecting a substitute, then accepts late publication", async () => {
    await setup({ entries: [meeting("other")] });
    expect(document.querySelector(".detail-placeholder").textContent).toBe(en["history.linkedMeetingNotFound"]);
    expect(selectedId()).toBeUndefined();
    expect(document.querySelectorAll(".meeting-card")).toHaveLength(1);
    publish([meeting("target"), meeting("other")]); await flush(); expect(selectedId()).toBe("target");
  });

  it("does not override the user's choice when the linked recording arrives", async () => {
    const recovery = deferred(); await setup({ entries: [meeting("other")], recovery: recovery.promise });
    document.querySelector('.meeting-card[data-meeting-id="other"]').click();
    publish([meeting("other"), meeting("target")]); await flush();
    recovery.resolve({}); await flush(); expect(selectedId()).toBe("other");
  });

  it("treats the query value as an exact ID", async () => {
    await setup({ target: '<img src=x onerror="alert(1)">', entries: [meeting("target")] });
    expect(document.querySelector(".detail-placeholder img")).toBeNull();
    expect(selectedId()).toBeUndefined();
  });
});
