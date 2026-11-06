import { directorySize } from "../../src/storage/meeting-directory-size.js";

const params = new URLSearchParams(location.search);
Object.defineProperty(navigator, 'language', { value: params.get('locale') || 'en' });
let historyChanged;
const openedAi = [], copiedTranscripts = [];
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copiedTranscripts.push(text) } });
const downloaded = [], preferences = { transcriptDownloadFormat: 'txt' };
const entry = { sessionId: 'browser', folderName: 'browser-history', meetingTitle: 'A long meeting title '.repeat(8), startedAt: Date.now(), durationMs: 60000, hasTranscript: true, hasVideo: true };
window.chrome = {
  runtime: { getURL: path => '/' + path, sendMessage: async message => {
    if (message.type !== "asterion:measure-meeting-size") return { ok: true };
    const root = await navigator.storage.getDirectory();
    return { bytes: await directorySize(await root.getDirectoryHandle(message.folderName)) };
  } },
  storage: { local: { get: (defaults, callback) => callback({ ...defaults, ...preferences, meetingHistory: [entry], debugLogging: true }), set: async values => { Object.assign(preferences, values); historyChanged({ transcriptDownloadFormat: { newValue: values.transcriptDownloadFormat } }, 'local'); } }, onChanged: { addListener: listener => { historyChanged = listener; } } },
  tabs: { async create(options) { openedAi.push(options); return { id: 100 }; } }, downloads: { download: options => downloaded.push(options), onChanged: { addListener() {}, removeListener() {} } },
};
const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(entry.folderName, { create: true });
async function write(name, data) {
  const stream = await (await folder.getFileHandle(name, { create: true })).createWritable(); await stream.write(data); await stream.close();
}
await write('transcripcion.json', JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ startTime: index * 10, speaker: 'Ana', text: 'A long transcript sentence for independent scroll position. '.repeat(4) }))));
await write('manifest.json', JSON.stringify({ entries: Array.from({ length: 200 }, (_, i) => ({ i, title: 'Manifest entry' })) }));
// Record a genuine, locally generated playable WebM with audio and video tracks.
const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
const context = canvas.getContext('2d'); context.fillStyle = '#385080'; context.fillRect(0, 0, 320, 180);
const audioContext = new AudioContext(); await audioContext.resume();
const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); gain.gain.value = .01;
const destination = audioContext.createMediaStreamDestination(); oscillator.connect(gain).connect(destination); oscillator.start();
const videoStream = canvas.captureStream(10);
const stream = new MediaStream([...videoStream.getTracks(), ...destination.stream.getTracks()]);
const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' }); const chunks = [];
recorder.ondataavailable = event => chunks.push(event.data);
const recorded = new Promise(resolve => { recorder.onstop = resolve; });
recorder.start(); await new Promise(resolve => setTimeout(resolve, 1800)); recorder.stop(); await recorded;
const blob = new Blob(chunks, { type: recorder.mimeType });
await write('video-reunion.webm', blob); await write('audio-reunion.webm', blob);
stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await audioContext.close();
await import('../../src/history/history.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw new Error('Fixture timeout'); await wait(20); } }
const assert = (value, message) => { if (!value) throw new Error(message); };
window.previewHistory = async (media = null) => {
  historyChanged({ meetingHistory: { newValue: [entry] } }, 'local');
  document.querySelector('.meeting-card').click();
  await until(() => document.querySelector('.transcript-list'));
  if (media) {
    document.querySelector(`[role="tab"][id$="-${media}-tab"]`).click();
    const panel = document.querySelector(`[role="tabpanel"][id$="-${media}-panel"]`);
    await until(() => panel.querySelector(media)?.readyState >= 1);
    panel.querySelector('.media-play').click(); await until(() => !panel.querySelector(media).paused); await wait(250);
  }
};
async function verifyMeetingSize() {
  const records = await folder.getDirectoryHandle("capture-records", { create: true });
  const nested = await records.getDirectoryHandle("nested", { create: true });
  const chunk = await (await nested.getFileHandle("chunk", { create: true })).createWritable();
  await chunk.write(new Uint8Array(1024 * 1024)); await chunk.close();
  await write("internal.extra", new Uint8Array(1024));
  const bytes = 1024 * 1024 + (await Promise.all(
    ["audio-reunion.webm", "video-reunion.webm", "transcripcion.json", "manifest.json", "internal.extra"]
      .map(async name => (await (await folder.getFileHandle(name)).getFile()).size),
  )).reduce((sum, size) => sum + size, 0);
  const suffix = { en: "on disk", es: "en disco", fr: "sur le disque" }[navigator.language];
  const label = `${(bytes / 1024 ** 2).toLocaleString(navigator.language, { maximumFractionDigits: 1 })} MB ${suffix}`;
  for (const width of [491, 210]) {
    historyChanged({ meetingHistory: { newValue: [entry] } }, "local");
    const card = document.querySelector(".meeting-card");
    card.style.width = `${width}px`;
    const size = card.querySelector(".meeting-size");
    const details = card.querySelector(".details-button");
    const height = card.offsetHeight, before = details.getBoundingClientRect();
    assert(size.textContent === "", "Pending size leaves its row empty");
    await until(() => size.textContent === label);
    const after = details.getBoundingClientRect();
    assert(size.title === label && card.offsetHeight === height && before.x === after.x && before.y === after.y,
      "Total size must not move View details or resize the card");
  }
  const empty = { ...entry, sessionId: "empty", folderName: "empty-meeting" };
  const missing = { ...entry, sessionId: "missing", folderName: "missing-meeting" };
  await (await navigator.storage.getDirectory()).getDirectoryHandle(empty.folderName, { create: true });
  historyChanged({ meetingHistory: { newValue: [entry, missing, empty] } }, "local");
  const sizeFor = id => document.querySelector(`[data-meeting-id="${id}"] .meeting-size`);
  await until(() => sizeFor("empty").textContent === `0 B ${suffix}`);
  const unavailable = { en: "Size unavailable", es: "Tamaño no disponible", fr: "Taille indisponible" }[navigator.language];
  await until(() => sizeFor("missing").textContent === unavailable);
  const getFile = FileSystemFileHandle.prototype.getFile;
  try {
    FileSystemFileHandle.prototype.getFile = function () {
      if (this.name === "internal.extra") return Promise.reject(new DOMException("Unreadable file", "NotReadableError"));
      return getFile.call(this);
    };
    historyChanged({ meetingHistory: { newValue: [entry, empty] } }, "local");
    await until(() => sizeFor("browser").textContent === unavailable && sizeFor("empty").textContent === `0 B ${suffix}`);
  } finally {
    FileSystemFileHandle.prototype.getFile = getFile;
  }
  await write("internal.extra", new Uint8Array(1024 * 1024 + 1024));
  historyChanged({ meetingHistory: { newValue: [entry] } }, "local");
  const updated = `${(bytes / 1024 ** 2 + 1).toLocaleString(navigator.language, { maximumFractionDigits: 1 })} MB ${suffix}`;
  await until(() => sizeFor("browser").textContent === updated);
}

window.runHistoryTest = async () => {
  await verifyMeetingSize();
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  assert(bg.toLowerCase() === (params.get('theme') === 'light' ? '#ffffff' : '#1a1d24'), 'Shared theme must match emulated appearance');
  document.querySelector('.meeting-card').click();
  const page = key => document.querySelector(`[role="tabpanel"][id$="-${key}-panel"]`);
  const select = key => document.querySelector(`[role="tab"][id$="-${key}-tab"]`).click();
  await until(() => page('transcript').querySelector('.transcript-list'));
  const transcriptFooter = page('transcript').querySelector('.detail-footer');
  const picker = transcriptFooter.querySelector('.transcript-format');
  const download = transcriptFooter.querySelector('.transcript-download');
  const copy = transcriptFooter.querySelector('.transcript-copy');
  assert(picker.value === 'txt', 'Transcript default must be TXT');
  for (const format of ['txt', 'md', 'json']) {
    const previousDownloads = downloaded.length;
    const previousCopies = copiedTranscripts.length;
    picker.value = format;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => preferences.transcriptDownloadFormat === format);
    assert(downloaded.length === previousDownloads && copiedTranscripts.length === previousCopies, 'Selection must only save the format');
    download.click();
    assert(downloaded.at(-1).filename.endsWith(`.${format}`) && downloaded.at(-1).saveAs, 'Download must use the selected format');
    copy.click();
    const text = await (await fetch(downloaded.at(-1).url)).text();
    assert(copiedTranscripts.at(-1) === text, 'Copy must match the downloaded file');
    if (format === 'txt') assert(text.includes('[00:00] [Ana]'), 'TXT must include speaker and timestamp');
    if (format === 'md') assert(text.startsWith('# A long meeting title'), 'Markdown must include the meeting title');
  }
  historyChanged({ transcriptDownloadFormat: { newValue: 'txt' } }, 'local');
  assert(picker.value === 'txt', 'Picker must synchronize with storage');
  for (const key of ['transcript', 'audio', 'video', 'manifest']) {
    const tab = document.querySelector(`[role="tab"][id$="-${key}-tab"]`);
    const trailingSpace = tab.getBoundingClientRect().right - tab.querySelector('span').getBoundingClientRect().right;
    assert(Math.abs(trailingSpace - parseFloat(getComputedStyle(tab).paddingRight)) < 1, `${key} must have only the standard trailing padding`);
    if (key === 'audio' || key === 'video') assert(tab.querySelector('.detail-playback-marker').hidden, 'Paused media must not reserve marker space');
  }
  assert(!document.querySelector('.transcript-actions'), 'Transcript AI actions must remain unavailable');
  const navigation = document.querySelector('.detail-navigation');
  const pager = document.querySelector('.detail-pager');
  assert(pager.getBoundingClientRect().top - navigation.getBoundingClientRect().bottom === 16, 'Tabs and content must have only the normal 16px gap');
  const pagerTop = pager.getBoundingClientRect().top;
  const deleteButton = document.querySelector('.delete-meeting-button');
  const deletePosition = deleteButton.getBoundingClientRect();
  const content = page('transcript').querySelector('.detail-tab-content'); content.scrollTop = 567;
  assert(content.scrollTop === 567, 'Transcript must have real scroll geometry');
  select('audio'); await until(() => page('audio').querySelector('audio')?.readyState >= 1);
  const audio = page('audio').querySelector('audio'); audio.loop = true;
  const audioTab = document.querySelector('[role="tab"][id$="-audio-tab"]');
  const idleWidth = audioTab.getBoundingClientRect().width;
  page('audio').querySelector('.media-play').click(); await until(() => !audio.paused);
  await wait(35);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const scale = new DOMMatrixReadOnly(getComputedStyle(audioTab, '::before').transform).a;
    assert(scale > idleWidth / audioTab.getBoundingClientRect().width && scale < 1, 'The active tab surface must have an intermediate size');
    assert(audioTab.querySelector('span').getAnimations().length === 0, 'The label must not be scaled');
  }
  await until(() => audio.currentTime > .1);
  const marker = audioTab.querySelector('.detail-playback-marker');
  const label = audioTab.querySelector('span');
  const markerRect = marker.getBoundingClientRect(), labelRect = label.getBoundingClientRect();
  assert(Math.abs(markerRect.y + markerRect.height / 2 - labelRect.y - labelRect.height / 2) < 1, 'Playback marker must align with the label center');
  assert(Math.abs(audioTab.getBoundingClientRect().width - idleWidth - 16) < 1, 'Playing tab must grow by the marker and its spacing only');
  assert(markerRect.left - labelRect.right >= 9.5, 'The fully expanded aura must leave clear space beside the label');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  assert(getComputedStyle(marker, '::after').animationName === (reducedMotion ? 'none' : 'playback-aura'), 'Aura must follow reduced-motion preference');
  select('transcript'); const initial = audio.currentTime; await wait(150);
  assert(pager.getBoundingClientRect().top === pagerTop, 'Playback feedback must not shift the pager');
  assert(!audio.paused && audio.currentTime > initial, 'Audio must continue offscreen');
  assert(!document.querySelector('.playback-status') && !document.querySelector('.detail-navigation .detail-action'), 'Tabs must not show an extra playback or pause control');
  assert(audioTab.classList.contains('is-playing') && !marker.hidden, 'Playing audio must have a green marker');
  assert(audioTab.getAttribute('aria-description').includes(document.documentElement.lang === 'fr' ? 'Lecture audio' : document.documentElement.lang === 'es' ? 'Reproduciendo audio' : 'Playing audio'), 'The playback marker must have an accessible description');
  assert(content.scrollTop === 567, 'Transcript scroll must survive navigation exactly');
  const output = await (await folder.getFileHandle('audio-reunion.webm')).getFile(); await write('audio-reunion.mp3', output);
  historyChanged({ meetingHistory: { newValue: [{ ...entry, hasAudioMp3: true }] } }, 'local');
  page('audio').querySelector('.split-primary').click(); await until(() => downloaded.at(-1).filename.endsWith('.mp3'));
  assert(page('audio').querySelector('audio') === audio && !audio.paused, 'Downloading converted audio must preserve the original playing element');
  select('video'); await until(() => page('video').querySelector('video')?.readyState >= 1);
  const video = page('video').querySelector('video'); video.loop = true;
  page('video').querySelector('.media-play').click(); await until(() => !video.paused && audio.paused);
  assert(document.querySelector('[role="tab"][id$="-video-tab"]').classList.contains('is-playing') && !audioTab.classList.contains('is-playing'), 'Only the playing video tab must have a marker');
  const audioTime = audio.currentTime;
  select('manifest'); await until(() => page('manifest').querySelector('pre'));
  const manifest = page('manifest').querySelector('.detail-tab-content'); manifest.scrollTop = 345;
  await wait(100); assert(!video.paused, 'Video must continue offscreen');
  select('audio'); page('audio').querySelector('.media-play').click(); await until(() => !audio.paused && video.paused);
  assert(audio.currentTime >= audioTime, 'Audio must resume from preserved time');
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  historyChanged({ meetingHistory: { newValue: [{ ...entry, meetingTitle: 'Updated title' }] } }, 'local');
  assert(panels.every(panel => panel.isConnected), 'Metadata must preserve panels');
  assert(!audio.paused, 'Metadata must preserve playback');
  select('manifest'); assert(manifest.scrollTop === 345, 'Manifest scroll must survive navigation');
  select('transcript'); assert(content.scrollTop === 567, 'Transcript scroll must remain exact');
  const tab = document.querySelector('[role="tab"][aria-selected="true"]'); tab.focus();
  tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert(document.activeElement.id.endsWith('manifest-tab'), 'End must move tab focus');
  assert(getComputedStyle(document.querySelector('.detail-track')).transitionDuration === '0s', 'Keyboard navigation must be instant');
  select('transcript'); select('video'); select('audio');
  assert(document.querySelectorAll('[role="tab"][aria-selected="true"]').length === 1, 'Rapid navigation must have one active tab');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) assert(getComputedStyle(document.querySelector('.detail-track')).transitionDuration === '0s', 'Reduced motion must be instant');
  assert(document.querySelectorAll('.delete-meeting-button').length === 1, 'Meeting deletion must have one common button');
  assert(deleteButton === document.querySelector('.delete-meeting-button') && deleteButton.getBoundingClientRect().y === deletePosition.y, 'Delete must stay fixed across tab changes and scrolling');
  select('manifest');
  document.querySelector('[role="tab"][id$="-manifest-tab"]').focus();
  historyChanged({ debugLogging: { newValue: false } }, 'local');
  assert(!page('manifest') && document.activeElement.id.endsWith('transcript-tab'), 'Disabling debug removes the manifest and transfers focus');
  assert(page('audio').querySelector('audio') === audio && !audio.paused, 'Debug changes must preserve playing media');
  assert([...document.querySelectorAll('.file-chip')].every(chip => !/manifest/i.test(chip.textContent)), 'Normal history must hide manifest chips');
  historyChanged({ debugLogging: { newValue: true } }, 'local');
  assert(page('manifest'), 'Enabling debug restores the manifest');
  for (let i = 0; i < 3; i++) { audio.pause(); await audio.play(); }
  audio.pause(); await wait(250);
  assert(marker.hidden && !audioTab.classList.contains('is-playing'), 'Rapid playback reversals must end paused');
  assert(!document.querySelector('.detail-playback-marker.is-exiting'), 'Temporary exit markers must be cleaned up');
  assert(audioTab.getBoundingClientRect().width === idleWidth, 'Pausing must restore the original tab size');
  const other = { ...entry, sessionId: 'other', meetingTitle: 'Another meeting' };
  historyChanged({ meetingHistory: { newValue: [entry, other] } }, 'local');
  const cards = document.querySelectorAll('.meeting-card');
  cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  const region = document.querySelector('.meeting-region');
  const animation = region.getAnimations()[0];
  assert(animation?.effect.getTiming().duration === (matchMedia('(prefers-reduced-motion: reduce)').matches ? 120 : 240), 'Meeting transition must use agreed duration');
  animation.pause(); animation.currentTime = animation.effect.getTiming().duration / 2;
  assert(Number(getComputedStyle(region).opacity) > 0 && Number(getComputedStyle(region).opacity) < 1, 'Meeting transition must be visible at half speed');
  assert(deleteButton.getBoundingClientRect().y === deletePosition.y, 'Delete must not move during meeting animation');
  cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  assert(animation.playState === 'idle' && region.getAnimations().length === 1, 'Rapid selection must cancel obsolete animation');
  cards[1].click(); assert(region.getAnimations().length === 0, 'Keyboard activation must be instant');
  assert(deleteButton === document.querySelector('.delete-meeting-button'), 'Delete identity must survive meeting changes');
  const scrollbar = getComputedStyle(document.querySelector('.meetings-list'), '::-webkit-scrollbar');
  assert(scrollbar.width === '8px', 'Chrome scrollbar width must be 8px');
  historyChanged({ meetingHistory: { newValue: [] } }, 'local');
  assert(audio.paused && video.paused && !audio.getAttribute('src') && !video.getAttribute('src'), 'Removed meeting must release both sources');
  return { passed: true, locale: document.documentElement.lang, theme: params.get('theme'), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
};
