import { describe, expect, it, vi } from "vitest";
import en from "../shared/i18n/locales/en.json";

document.body.innerHTML = `
  <aside class="sidebar" aria-label="Filtros del historial">
    <div class="brand"><img alt="" /><span>Ariadne</span></div>
    <div><h1 id="page-heading" class="sidebar-heading">Historial</h1><p id="page-description" class="sidebar-description"></p></div>
    <div class="search-field"><span id="search-icon" class="search-icon" aria-hidden="true"></span><input id="search-input" type="search" /></div>
    <section aria-labelledby="filters-label" hidden><span id="filters-label" class="section-label"></span><div id="filter-chips" class="filter-chips"></div></section>
    <section class="calendar" aria-label="Calendario"><div id="calendar"></div></section>
    <section aria-labelledby="kpis-label"><span id="kpis-label" class="section-label"></span><div id="kpis" class="kpis"></div></section>
  </aside>
  <section class="meetings-panel" aria-labelledby="meetings-title">
    <header class="meetings-header"><div><h2 id="meetings-title" class="meetings-title"></h2><p id="results-count" class="results-count"></p></div><label class="sort-control"><select id="sort-select"><option value="newest">Newest</option><option value="oldest">Oldest</option></select><span id="sort-chevron" class="sort-chevron" aria-hidden="true"></span></label></header>
    <div id="meetings-list" class="meetings-list" aria-live="polite"></div>
  </section>
  <section id="detail-panel" class="detail-panel" aria-label="Detalle de reunión"></section>
`;

let historyChanged;
globalThis.chrome = {
  runtime: { getURL: (path) => path },
  storage: {
    local: {
      get: (defaults, callback) => callback({ ...defaults, debugLogging: true }),
      set: () => {},
    },
    onChanged: { addListener: listener => { historyChanged = listener; } },
  },
  tabs: { create: () => {}, sendMessage: () => {} },
  downloads: { download: () => {}, onChanged: { addListener: () => {}, removeListener: () => {} } },
};
globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => Object.fromEntries(
  [... ["untitledMeeting", "transcript", "audio", "video", "manifest"].map(key => [`common.${key}`, en[`common.${key}`]]), ...Object.entries(en).filter(([key]) => key.startsWith("history.download") || ["copyTranscript", "openWithAi", "openInAi", "preparingTranscript", "transcriptReadError", "transcriptCopied", "transcriptCopyError", "aiTabOpened", "aiOpenError"].some(name => key === `history.${name}`))]
) }));

const { deriveVisibleMeetings } = await import("./history.js");

function meeting(overrides) {
  return {
    sessionId: "s1",
    folderName: "folder-1",
    meetingTitle: "Weekly sync",
    startedAt: new Date("2026-01-05T10:00:00Z").getTime(),
    hasTranscript: true,
    hasVideo: false,
    ...overrides,
  };
}

describe("deriveVisibleMeetings", () => {
  it("matches title OR literal transcript fragments with existing filters and ordering", () => {
    const items = [meeting({ sessionId: "1", meetingTitle: "Instant meeting" }), meeting({ sessionId: "2", meetingTitle: "OLA" })];
    const current = { meetings: items, search: " OLA ", filters: {}, sort: "newest", selectedDay: null,
      transcriptSearch: { textFor: () => "las olas café [precio]. entre segmentos" } };
    expect(deriveVisibleMeetings(current)).toHaveLength(2);
    current.search = "[PRECIO]."; expect(deriveVisibleMeetings(current)).toHaveLength(2);
    current.search = "entre segmentos"; expect(deriveVisibleMeetings(current)).toHaveLength(2);
    current.search = "cafe"; expect(deriveVisibleMeetings(current)).toHaveLength(0);
    current.search = "ola"; current.filters.video = true; expect(deriveVisibleMeetings(current)).toHaveLength(0);
    current.filters = {}; current.selectedDay = new Date("2000-01-01"); expect(deriveVisibleMeetings(current)).toHaveLength(0);
  });
  it("filters by search text (case/locale-insensitive)", () => {
    const state = { meetings: [meeting({ meetingTitle: "Café con equipo" })], search: "CAFÉ", filters: {}, sort: "newest", selectedDay: null };
    expect(deriveVisibleMeetings(state)).toHaveLength(1);
  });

  it("excludes meetings without a transcript when the transcript filter is on", () => {
    const state = { meetings: [meeting({ hasTranscript: false })], search: "", filters: { transcript: true }, sort: "newest", selectedDay: null };
    expect(deriveVisibleMeetings(state)).toHaveLength(0);
  });

  it("sorts oldest first when requested", () => {
    const older = meeting({ sessionId: "old", startedAt: new Date("2026-01-01T00:00:00Z").getTime() });
    const newer = meeting({ sessionId: "new", startedAt: new Date("2026-01-10T00:00:00Z").getTime() });
    const state = { meetings: [newer, older], search: "", filters: {}, sort: "oldest", selectedDay: null };
    expect(deriveVisibleMeetings(state).map((m) => m.sessionId)).toEqual(["old", "new"]);
  });
});

it("shows title matches while reading, searches saved content, and clears errors on the next query", async () => {
  const { MemoryDirectoryHandle } = await import("../../tests/helpers/memory-opfs.js");
  const root = new MemoryDirectoryHandle("search-root");
  const folder = await root.getDirectoryHandle("search-folder", { create: true });
  const file = await folder.getFileHandle("transcripcion.json", { create: true });
  const writer = await file.createWritable(); await writer.write(JSON.stringify([{ text: "Las OLAS", speaker: "Only speaker" }, { text: "son grandes." }])); await writer.close();
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => { await delayed; return root; } } });
  const items = [meeting({ sessionId: "content-match", folderName: "search-folder", meetingTitle: "Instant meeting" }),
    meeting({ sessionId: "title-match", folderName: "absent", meetingTitle: "Olas", hasTranscript: false })];
  historyChanged({ meetingHistory: { newValue: items } }, "local");
  const input = document.getElementById("search-input");
  const search = value => { input.value = value; input.dispatchEvent(new Event("input")); };
  search("ola");
  expect(document.querySelectorAll(".meeting-card")).toHaveLength(1);
  expect(document.getElementById("meetings-list").getAttribute("aria-busy")).toBe("true");
  search("olas son"); release();
  await vi.waitFor(() => expect(document.querySelector(".meeting-card")?.dataset.meetingId).toBe("content-match"));
  search("Only speaker"); expect(document.querySelectorAll(".meeting-card")).toHaveLength(0);
  historyChanged({ meetingHistory: { newValue: [...items, meeting({ sessionId: "missing", folderName: "missing", meetingTitle: "Fallback title" })] } }, "local");
  search("fallback");
  await vi.waitFor(() => expect(document.getElementById("results-count").textContent).toContain("history.transcriptSearchError"));
  expect(document.querySelector(".meeting-card")?.dataset.meetingId).toBe("missing");
  search(""); expect(document.querySelectorAll(".meeting-card")).toHaveLength(3);
  expect(document.getElementById("results-count").textContent).not.toContain("history.transcriptSearchError");
  historyChanged({ meetingHistory: { newValue: [] } }, "local");
});

it("renders recovery states, deduplicates retry, and preserves content on progress updates", async () => {
  const { MemoryDirectoryHandle } = await import("../../tests/helpers/memory-opfs.js");
  const root = new MemoryDirectoryHandle("root");
  const folder = await root.getDirectoryHandle("recovery-folder", { create: true });
  const file = await folder.getFileHandle("transcripcion.json", { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify([{ index: 0, startTime: 0, endTime: 1, text: "Saved", speaker: "Ana" }])); await writable.close();
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
  const entry = meeting({ folderName: "recovery-folder", recordingStatus: "incomplete", audioConversionStatus: "pending",
    transcriptExportStatus: "succeeded", processing: { supported: true, pending: true, canRetry: false, tasks: [] } });
  chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ ...entry, recovery: entry.processing });
  historyChanged({ meetingHistory: { newValue: [entry] } }, "local");
  document.querySelector(".meeting-card").click();
  await vi.waitFor(() => expect(document.querySelector(".transcript-list")).toBeTruthy());
  const content = document.querySelector(".transcript-list");
  const button = document.querySelector(".recovery-retry");
  expect(button.hidden).toBe(true);
  expect(button.disabled).toBe(true);
  expect(document.querySelector(".recovery-panel").hidden).toBe(false);
  expect(document.querySelector(".recovery-status")).toBeNull();
  expect(document.querySelector(".recovery-message").getAttribute("role")).toBe("status");
  const failed = { ...entry, audioConversionStatus: "failed", processing: { supported: true, pending: false, canRetry: true, tasks: [{ stream: "meeting", state: "failed", error: "INPUT_INVALID" }] } };
  chrome.runtime.sendMessage.mockResolvedValue({ ...failed, recovery: failed.processing });
  historyChanged({ meetingHistory: { newValue: [failed] } }, "local");
  expect(document.querySelector(".transcript-list")).toBe(content);
  expect(document.querySelector(".recovery-retry")).toBe(button);
  expect(button.hidden).toBe(false);
  expect(button.disabled).toBe(false);
  button.click(); button.click();
  await vi.waitFor(() => expect(chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === "asterion:retry-recovery")).toHaveLength(1));
  const completed = { ...entry, audioConversionStatus: "succeeded", processing: { supported: true, pending: false, canRetry: false, tasks: [] } };
  chrome.runtime.sendMessage.mockResolvedValue({ ...completed, recovery: completed.processing });
  historyChanged({ meetingHistory: { newValue: [completed] } }, "local");
  expect(document.querySelector(".recovery-panel").hidden).toBe(true);
  expect(document.querySelector(".transcript-list")).toBe(content);
});

it("uses understandable quota and unrecoverable-data errors", async () => {
  const { recoveryErrorMessage } = await import("./history.js");
  expect(recoveryErrorMessage("QuotaExceededError")).toBe("history.recoveryQuotaError");
  expect(recoveryErrorMessage("INPUT_INVALID: no continuous saved prefix")).toBe("history.recoveryNoData");
});


it("does not show incompleteness notices for legacy recovered meetings", async () => {
  const entry = meeting({ folderName: "recovery-folder", recordingStatus: "incomplete", transcriptStatus: "incomplete",
    audioConversionStatus: "succeeded", transcriptExportStatus: "succeeded",
    processing: { supported: true, pending: false, canRetry: false, recoveredCoverage: { meeting: { partial: true } }, tasks: [] } });
  chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ ...entry, recovery: entry.processing });
  historyChanged({ meetingHistory: { newValue: [entry] } }, "local");
  document.querySelector(".meeting-card").click();
  await vi.waitFor(() => expect(document.querySelector(".recovery-panel").hidden).toBe(true));
  expect(document.querySelector(".recovery-status")).toBeNull();
  expect(document.querySelector(".meeting-date").textContent).not.toContain("incomplete");
  expect(document.querySelector(".recovery-message").textContent).toBe("");
});

async function openFixture(id = 'pager') {
  const { MemoryDirectoryHandle } = await import('../../tests/helpers/memory-opfs.js');
  const root = new MemoryDirectoryHandle('root');
  for (const folderName of [id, `${id}-other`]) {
    const folder = await root.getDirectoryHandle(folderName, { create: true });
    for (const [name, value] of Object.entries({
      'transcripcion.json': JSON.stringify([{ startTime: 0, speaker: 'Ana', text: 'Persistent transcript' }]),
      'manifest.json': JSON.stringify({ folderName }),
      'audio-reunion.webm': 'audio', 'video-reunion.webm': 'video',
    })) {
      const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await writable.write(value); await writable.close();
    }
  }
  const getDirectory = vi.fn(async () => root);
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory } });
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () {
    Object.defineProperty(this, 'paused', { configurable: true, value: true }); this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); return Promise.resolve();
  });
  const entry = meeting({ sessionId: id, folderName: id, hasVideo: true });
  chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ ok: true });
  historyChanged({ meetingHistory: { newValue: [entry, { ...entry, sessionId: `${id}-other`, folderName: `${id}-other` }] } }, 'local');
  document.querySelector('.meeting-card').click();
  await vi.waitFor(() => expect(document.querySelector('.transcript-list')).toBeTruthy());
  const select = key => document.querySelector(`[role="tab"][id$="-${key}-tab"]`).click();
  const page = key => document.querySelector(`[role="tabpanel"][id$="-${key}-panel"]`);
  return { root, entry, getDirectory, select, page };
}

it('names every download using the meeting title, file type and actual extension', async () => {
  const { root, entry, select, page } = await openFixture('download-names');
  const updated = { ...entry, meetingTitle: '  Reunión: -- sobre   algo! ', hasAudioMp3: true, hasVideoMp4: true };
  const folder = await root.getDirectoryHandle(entry.folderName);
  for (const name of ['audio-reunion.mp3', 'video-reunion.mp4']) {
    const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
    await writable.write('converted'); await writable.close();
  }
  historyChanged({ meetingHistory: { newValue: [updated] } }, 'local');
  chrome.downloads.download = vi.fn();
  for (const [tab, extensions, type] of [
    ['transcript', ['txt', 'md', 'json'], 'transcript'],
    ['audio', ['mp3'], 'audio'],
    ['video', ['mp4'], 'video'],
    ['manifest', ['json'], 'manifest'],
  ]) {
    select(tab);
    await vi.waitFor(() => expect(page(tab).querySelector('.detail-footer')).toBeTruthy());
    expect(page(tab).querySelector('.detail-file-name').textContent).toBe(`reunion-sobre-algo-${type}.${extensions[0]}`);
    expect(page(tab).querySelector('[aria-label="Open"]')).toBeNull();
    for (const extension of extensions) {
      if (tab === 'transcript') {
        page(tab).querySelector('.split-trigger').click();
        [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent.includes(`.${extension}`)).click();
      } else page(tab).querySelector('.split-primary').click();
      await vi.waitFor(() => expect(chrome.downloads.download).toHaveBeenLastCalledWith(
        expect.objectContaining({ filename: `reunion-sobre-algo-${type}.${extension}` }), expect.any(Function)));
      expect(page(tab).querySelector('.detail-file-name').textContent).toBe(`reunion-sobre-algo-${type}.${extension}`);
    }
  }
  for (const tab of ['audio', 'video']) {
    await folder.removeEntry(`${tab}-reunion.${tab === 'audio' ? 'mp3' : 'mp4'}`);
  }
  historyChanged({ meetingHistory: { newValue: [{ ...updated, hasAudioMp3: false, hasVideoMp4: false }] } }, 'local');
  for (const tab of ['audio', 'video']) {
    select(tab);
    await vi.waitFor(() => expect(page(tab).querySelector('.detail-file-name').textContent).toBe(`reunion-sobre-algo-${tab}.webm`));
    page(tab).querySelector('.split-primary').click();
    await vi.waitFor(() => expect(chrome.downloads.download).toHaveBeenLastCalledWith(
      expect.objectContaining({ filename: `reunion-sobre-algo-${tab}.webm` }), expect.any(Function)));
  }
});

it('remembers formats, synchronizes them and downloads even when preference persistence fails', async () => {
  const { page } = await openFixture('format-preference');
  historyChanged({ transcriptDownloadFormat: { newValue: 'invalid' } }, 'local');
  expect(page('transcript').querySelector('.split-primary').textContent).toContain('TXT');
  chrome.storage.local.set = vi.fn().mockRejectedValue(new Error('Cannot save'));
  chrome.downloads.download = vi.fn();
  page('transcript').querySelector('.split-trigger').click();
  [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent.includes('.md')).click();
  await vi.waitFor(() => expect(page('transcript').querySelector('.download-feedback').textContent).toContain('could not be remembered'));
  expect(chrome.storage.local.set).toHaveBeenCalledWith({ transcriptDownloadFormat: 'md' });
  expect(chrome.downloads.download).toHaveBeenCalledWith(expect.objectContaining({ filename: 'weekly-sync-transcript.md' }), expect.any(Function));
  expect(page('transcript').querySelector('.split-primary').textContent).toContain('MD');
  const exported = URL.createObjectURL.mock.calls.at(-1)[0];
  const content = exported.text ? await exported.text() : await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(exported); });
  expect(content).toContain('# Weekly sync'); expect(content).toContain('Persistent transcript');
  expect(page('transcript').querySelector('.detail-file-size').textContent).toBe(`${exported.size} B`);
  historyChanged({ transcriptDownloadFormat: { newValue: 'json' } }, 'local');
  expect(page('transcript').querySelector('.split-primary').textContent).toContain('JSON');
  expect(page('transcript').querySelector('.download-feedback').textContent).toBe('');
  chrome.storage.local.set = vi.fn().mockResolvedValue(undefined);
  historyChanged({ transcriptDownloadFormat: { newValue: 'txt' } }, 'local');
});

it('downloads newly converted media while the original player continues running', async () => {
  const { page, select, entry, root } = await openFixture('download-during-play');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); page('audio').querySelector('.media-play').click(); await Promise.resolve();
  const folder = await root.getDirectoryHandle(entry.folderName);
  const writable = await (await folder.getFileHandle('audio-reunion.mp3', { create: true })).createWritable(); await writable.write('converted'); await writable.close();
  historyChanged({ meetingHistory: { newValue: [{ ...entry, hasAudioMp3: true }] } }, 'local');
  chrome.downloads.download = vi.fn(); page('audio').querySelector('.split-primary').click();
  await vi.waitFor(() => expect(chrome.downloads.download).toHaveBeenCalledWith(expect.objectContaining({ filename: 'weekly-sync-audio.mp3' }), expect.any(Function)));
  expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
  const empty = await (await folder.getFileHandle('audio-reunion.mp3')).createWritable(); await empty.close();
  page('audio').querySelector('.split-primary').click();
  await vi.waitFor(() => expect(chrome.downloads.download).toHaveBeenLastCalledWith(expect.objectContaining({ filename: 'weekly-sync-audio.webm' }), expect.any(Function)));
});

it('keeps mounted pages, independent scroll, media state and file-specific actions', async () => {
  const { select, page, getDirectory } = await openFixture();
  const transcript = page('transcript'); const content = transcript.querySelector('.detail-tab-content'); content.scrollTop = 123;
  select('audio'); select('audio');
  await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); audio.currentTime = 12; audio.volume = .4; audio.playbackRate = 1.5;
  page('audio').querySelector('.media-play').click(); await Promise.resolve();
  select('transcript');
  expect(audio.paused).toBe(false); expect(page('transcript')).toBe(transcript); expect(content.scrollTop).toBe(123);
  expect(page('audio').inert).toBe(true);
  select('video'); await vi.waitFor(() => expect(page('video').querySelector('video')).toBeTruthy());
  const video = page('video').querySelector('video'); video.currentTime = 8; video.volume = .7;
  page('video').querySelector('.media-play').click(); await Promise.resolve();
  expect(audio.paused).toBe(true); expect(audio.currentTime).toBe(12); expect(audio.volume).toBe(.4); expect(audio.playbackRate).toBe(1.5);
  select('manifest'); await vi.waitFor(() => expect(page('manifest').querySelector('pre')).toBeTruthy());
  expect(video.paused).toBe(false);
  const reads = getDirectory.mock.calls.length;
  select('audio'); page('audio').querySelector('.media-play').click(); await Promise.resolve();
  expect(video.paused).toBe(true); expect(video.currentTime).toBe(8); expect(video.volume).toBe(.7);
  select('transcript'); select('manifest'); select('audio');
  expect(getDirectory).toHaveBeenCalledTimes(reads);
  chrome.downloads.download = vi.fn();
  page('audio').querySelector('.split-primary').click();
  await vi.waitFor(() => expect(chrome.downloads.download.mock.calls[0][0].filename).toBe('weekly-sync-audio.webm'));
  expect(transcript.querySelectorAll('.split-primary')).toHaveLength(1);
  expect(transcript.querySelectorAll('.detail-action')).toHaveLength(0);
  document.querySelector('.meeting-card.is-selected').click();
  expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
});

it('shows the manifest only in debug mode and updates live without interrupting media', async () => {
  const { select, page } = await openFixture('debug-preference');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio');
  page('audio').querySelector('.media-play').click(); await Promise.resolve();
  select('manifest'); await vi.waitFor(() => expect(page('manifest').querySelector('pre')).toBeTruthy());
  document.querySelector('[role="tab"][id$="-manifest-tab"]').focus();
  const oldManifest = page('manifest');
  historyChanged({ debugLogging: { newValue: false } }, 'local');
  expect(page('manifest')).toBeNull(); expect(oldManifest.isConnected).toBe(false);
  expect([...document.querySelectorAll('.file-chip')].some(chip => chip.textContent.trim().endsWith(en['common.manifest']))).toBe(false);
  expect(document.activeElement.id).toMatch(/transcript-tab$/);
  expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
  historyChanged({ debugLogging: { newValue: true } }, 'local');
  expect(page('manifest')).toBeTruthy(); expect(page('manifest')).not.toBe(oldManifest);
  expect([...document.querySelectorAll('.file-chip')].some(chip => chip.textContent.trim().endsWith(en['common.manifest']))).toBe(true);
  select('audio'); historyChanged({ debugLogging: { newValue: undefined } }, 'local');
  expect(document.querySelector('[role="tab"][aria-selected="true"]').id).toMatch(/audio-tab$/);
  expect(page('manifest')).toBeNull(); expect(audio.paused).toBe(false);
  historyChanged({ debugLogging: { newValue: true } }, 'local');
});

it('preserves metadata updates, refreshes converted media only while paused, and cleans up on another meeting', async () => {
  const { root, entry, select, page } = await openFixture('conversion');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); audio.currentTime = 17; audio.volume = .3; audio.playbackRate = 2;
  page('audio').querySelector('.media-play').click(); await Promise.resolve();
  const folder = await root.getDirectoryHandle(entry.folderName);
  const writable = await (await folder.getFileHandle('audio-reunion.mp3', { create: true })).createWritable(); await writable.write('converted'); await writable.close();
  historyChanged({ meetingHistory: { newValue: [{ ...entry, hasAudioMp3: true, meetingTitle: 'Updated' }, { ...entry, sessionId: 'conversion-other', folderName: 'conversion-other' }] } }, 'local');
  expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
  expect(page('audio').querySelector('.detail-file-name').textContent).toBe('updated-audio.webm');
  audio.pause(); select('manifest'); select('audio');
  await vi.waitFor(() => expect(page('audio').querySelector('audio')).not.toBe(audio));
  const replacement = page('audio').querySelector('audio'); replacement.dispatchEvent(new Event('loadedmetadata'));
  expect(replacement.currentTime).toBe(17); expect(replacement.volume).toBe(.3); expect(replacement.playbackRate).toBe(2);
  document.querySelectorAll('.meeting-card')[1].click();
  expect(replacement.getAttribute('src')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalled();
});

it('supports keyboard navigation and ignores late loads from closed sessions', async () => {
  const { select, page } = await openFixture('late');
  let resolveDirectory;
  navigator.storage.getDirectory = () => new Promise(resolve => { resolveDirectory = resolve; });
  const old = page('manifest'); select('manifest'); select('manifest');
  expect(resolveDirectory).toBeTypeOf('function');
  document.querySelectorAll('.meeting-card')[1].click();
  resolveDirectory({ getDirectoryHandle: async () => { throw new Error('Closed'); } });
  await Promise.resolve(); await Promise.resolve();
  expect(old.querySelector('pre')).toBeNull(); expect(old.isConnected).toBe(false);
  const tab = document.querySelector('[role="tab"]'); tab.focus();
  tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement.id).toMatch(/manifest-tab$/);
  expect(document.querySelector('.detail-track').classList.contains('is-immediate')).toBe(true);
});

it('keeps existing playback when a new player fails and rejects superseded play requests', async () => {
  const { select, page } = await openFixture('intent');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); page('audio').querySelector('.media-play').click(); await Promise.resolve();
  select('video'); await vi.waitFor(() => expect(page('video').querySelector('video')).toBeTruthy());
  const video = page('video').querySelector('video'); video.play = vi.fn().mockRejectedValue(new Error('Blocked'));
  page('video').querySelector('.media-play').click(); await Promise.resolve(); expect(audio.paused).toBe(false);
  let finishVideo; video.play = () => new Promise(resolve => { finishVideo = resolve; });
  page('video').querySelector('.media-play').click();
  audio.dispatchEvent(new Event('playing')); expect(audio.paused).toBe(false);
  audio.pause(); select('audio'); page('audio').querySelector('.media-play').click(); await Promise.resolve();
  Object.defineProperty(video, 'paused', { configurable: true, value: false }); video.dispatchEvent(new Event('playing')); finishVideo(); await Promise.resolve();
  expect(video.paused).toBe(true); expect(audio.paused).toBe(false);
});

it('adds and removes available tabs without detaching unrelated players and releases media on delete', async () => {
  const { entry, select, page } = await openFixture('availability');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); page('audio').querySelector('.media-play').click(); await Promise.resolve();
  historyChanged({ meetingHistory: { newValue: [{ ...entry, hasTranscript: false }] } }, 'local');
  expect(page('transcript')).toBeNull(); expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
  historyChanged({ meetingHistory: { newValue: [entry] } }, 'local');
  expect(page('transcript')).toBeTruthy(); expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
  document.querySelector('.delete-meeting-button').click(); document.querySelector('.modal-confirm').click();
  await vi.waitFor(() => expect(document.querySelector('.detail-placeholder')).toBeTruthy());
  expect(audio.paused).toBe(true); expect(audio.getAttribute('src')).toBeNull();
});

it('keeps the shared delete button across pages and meetings and targets the current meeting', async () => {
  const { select, page } = await openFixture('shared-footer');
  const button = document.querySelector('.delete-meeting-button');
  select('audio'); select('manifest');
  expect(document.querySelectorAll('.delete-meeting-button')).toHaveLength(1);
  expect(button.closest('.detail-page')).toBeNull();
  document.querySelectorAll('.meeting-card')[1].querySelector('.details-button').focus();
  document.querySelectorAll('.meeting-card')[1].querySelector('.details-button').click();
  expect(document.querySelector('.delete-meeting-button')).toBe(button);
  expect(document.activeElement.className).toBe('details-button');
  button.click(); document.querySelector('.modal-confirm').click();
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'asterion:delete-session', sessionId: 'shared-footer-other' })));
});
it('preserves open media when another meeting is deleted and reports deletion errors', async () => {
  const { select, page } = await openFixture('delete-other');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); page('audio').querySelector('.media-play').click(); await Promise.resolve();
  const more = document.querySelectorAll('.more-button')[1]; more.click(); document.querySelector('.more-menu-item').click();
  chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Delete failed'));
  document.querySelector('.modal-confirm').click();
  await vi.waitFor(() => expect(document.querySelector('.action-error').hidden).toBe(false));
  expect(audio.paused).toBe(false); expect(document.querySelector('.modal-confirm').disabled).toBe(false);
  chrome.runtime.sendMessage.mockResolvedValue({ ok: true }); document.querySelector('.modal-confirm').click();
  await vi.waitFor(() => expect(document.querySelector('.delete-modal')).toBeNull());
  expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
  expect(document.activeElement.className).toBe('details-button');
});
it('indicates playback only on the media tab and keeps pause in the player', async () => {
  const { select, page } = await openFixture('play-status');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); audio.currentTime = 15;
  page('audio').querySelector('.media-play').click(); await Promise.resolve(); select('transcript');
  expect(document.querySelector('.playback-status')).toBeNull();
  expect(document.querySelector('.detail-navigation .detail-action')).toBeNull();
  expect(page('audio').getAttribute('aria-hidden')).toBe('true');
  const tab = document.querySelector('[role="tab"][id$="audio-tab"]');
  expect(tab.classList.contains('is-playing')).toBe(true);
  expect(tab.getAttribute('aria-description')).toBe('history.playingAudio');
  select('audio'); page('audio').querySelector('.media-play').click();
  expect(audio.paused).toBe(true); expect(audio.currentTime).toBe(15);
  expect(tab.classList.contains('is-playing')).toBe(false); expect(tab.hasAttribute('aria-description')).toBe(false);
});
it('opens the menu by keyboard, handles Escape, and only animates pointer changes between meetings', async () => {
  const { entry } = await openFixture('motion');
  const more = document.querySelector('.more-button'); more.click();
  expect(document.activeElement.className).toBe('more-menu-item');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.querySelector('.more-menu')).toBeNull(); expect(document.activeElement).toBe(more);
  const animations = [];
  const originalAnimate = Element.prototype.animate;
  const animate = Element.prototype.animate = vi.fn(() => { const animation = { cancel: vi.fn(), finished: Promise.resolve() }; animations.push(animation); return animation; });
  document.querySelectorAll('.meeting-card')[1].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(animate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transform: 'translateY(4px)' })]), expect.objectContaining({ duration: 240 }));
  const calls = animate.mock.calls.length;
  document.querySelectorAll('.meeting-card')[1].click(); expect(animate).toHaveBeenCalledTimes(calls);
  historyChanged({ meetingHistory: { newValue: [{ ...entry }, { ...entry, sessionId: 'motion-other', folderName: 'motion-other', meetingTitle: 'New title' }] } }, 'local');
  expect(animate).toHaveBeenCalledTimes(calls);
  document.querySelectorAll('.meeting-card')[0].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(animations[0].cancel).toHaveBeenCalled(); Element.prototype.animate = originalAnimate;
});

describe('disabled transcript AI integration', () => {
  it.each(['transcript', 'audio', 'video', 'manifest'])('keeps AI actions unavailable and local content accessible on the %s tab', async key => {
    const { select, page } = await openFixture(`disabled-ai-${key}`);
    select(key);
    await vi.waitFor(() => expect(page(key).querySelector('.detail-footer')).toBeTruthy());
    expect(page(key).getAttribute('aria-hidden')).toBe('false');
    expect(page(key).querySelector('.detail-footer .split-primary').disabled).toBe(false);
    expect(document.querySelector('.transcript-actions')).toBeNull();
    expect(document.querySelector('.detail-navigation .split-trigger')).toBeNull();
    if (key === 'transcript') expect(page(key).textContent).toContain('Persistent transcript');
    const media = page(key).querySelector('audio,video');
    if (media) {
      page(key).querySelector('.media-play').click();
      await vi.waitFor(() => expect(media.paused).toBe(false));
      expect(page(key).querySelector('audio,video')).toBe(media);
    }
    historyChanged({ meetingHistory: { newValue: [] } }, 'local');
  });

  it('keeps AI actions unavailable after transcript availability changes and switching meetings', async () => {
    const { entry, select, page } = await openFixture('disabled-ai-updates');
    const other = { ...entry, sessionId: 'disabled-ai-updates-other', folderName: 'disabled-ai-updates-other' };
    historyChanged({ meetingHistory: { newValue: [{ ...entry, hasTranscript: false }, other] } }, 'local');
    expect(page('transcript')).toBeNull();
    expect(document.querySelector('.transcript-actions')).toBeNull();
    historyChanged({ meetingHistory: { newValue: [entry, other] } }, 'local');
    select('transcript');
    await vi.waitFor(() => expect(page('transcript').textContent).toContain('Persistent transcript'));
    expect(document.querySelector('.transcript-actions')).toBeNull();
    document.querySelectorAll('.meeting-card')[1].click();
    await vi.waitFor(() => expect(page('transcript').textContent).toContain('Persistent transcript'));
    expect(document.querySelector('.transcript-actions')).toBeNull();
    expect(document.querySelector('.detail-navigation .split-trigger')).toBeNull();
    historyChanged({ meetingHistory: { newValue: [] } }, 'local');
  });
});


it.each([["teams", "Microsoft Teams"], ["meet", "Google Meet"], [undefined, null]])('displays the saved platform %s without guessing legacy recordings', async (platform, label) => {
  const { entry } = await openFixture(`platform-${platform ?? 'legacy'}`);
  historyChanged({ meetingHistory: { newValue: [{ ...entry, platform }] } }, 'local');
  const metadata = document.querySelector('.detail-metadata').textContent;
  if (label) expect(metadata).toContain(label);
  else { expect(metadata).not.toContain('Google Meet'); expect(metadata).not.toContain('Microsoft Teams'); }
});
