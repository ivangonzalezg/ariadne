import { describe, expect, it, vi } from "vitest";

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
      get: (defaults, callback) => callback(defaults),
      set: () => {},
    },
    onChanged: { addListener: listener => { historyChanged = listener; } },
  },
  tabs: { create: () => {}, sendMessage: () => {} },
  downloads: { download: () => {}, onChanged: { addListener: () => {}, removeListener: () => {} } },
};
globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));

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
  page('audio').querySelectorAll('.detail-action')[1].click();
  expect(chrome.downloads.download.mock.calls[0][0].filename).toBe('audio-reunion.webm');
  expect(transcript.querySelectorAll('.detail-action')).toHaveLength(4);
  document.querySelector('.meeting-card.is-selected').click();
  expect(page('audio').querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false);
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
it('coordinates the common pause control and indicator without shifting the selected page', async () => {
  const { select, page } = await openFixture('play-status');
  select('audio'); await vi.waitFor(() => expect(page('audio').querySelector('audio')).toBeTruthy());
  const audio = page('audio').querySelector('audio'); audio.currentTime = 15;
  page('audio').querySelector('.media-play').click(); await Promise.resolve(); select('transcript');
  const bar = document.querySelector('.playback-status'); expect(bar.hidden).toBe(false);
  expect(bar.textContent).toContain('history.playingAudio'); expect(page('audio').getAttribute('aria-hidden')).toBe('true');
  expect(document.querySelector('[role="tab"][id$="audio-tab"]').classList.contains('is-playing')).toBe(true);
  bar.querySelector('button').click(); expect(audio.paused).toBe(true); expect(audio.currentTime).toBe(15); expect(bar.hidden).toBe(true);
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
