const params = new URLSearchParams(location.search);
Object.defineProperty(navigator, 'language', { value: params.get('locale') || 'en' });
let historyChanged;
const entry = { sessionId: 'browser', folderName: 'browser-history', meetingTitle: 'A long meeting title '.repeat(8), startedAt: Date.now(), durationMs: 60000, hasTranscript: true, hasVideo: true };
window.chrome = {
  runtime: { getURL: path => '/' + path, sendMessage: async () => ({ ok: true }) },
  storage: { local: { get: (defaults, callback) => callback({ ...defaults, meetingHistory: [entry] }) }, onChanged: { addListener: listener => { historyChanged = listener; } } },
  tabs: { create() {} }, downloads: { download() {}, onChanged: { addListener() {}, removeListener() {} } },
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
window.previewHistory = async () => {
  historyChanged({ meetingHistory: { newValue: [entry] } }, 'local');
  document.querySelector('.meeting-card').click();
  await until(() => document.querySelector('.transcript-list'));
};
window.runHistoryTest = async () => {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  assert(bg.toLowerCase() === (params.get('theme') === 'light' ? '#ffffff' : '#1a1d24'), 'Shared theme must match emulated appearance');
  document.querySelector('.meeting-card').click();
  const page = key => document.querySelector(`[role="tabpanel"][id$="-${key}-panel"]`);
  const select = key => document.querySelector(`[role="tab"][id$="-${key}-tab"]`).click();
  await until(() => page('transcript').querySelector('.transcript-list'));
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
  page('audio').querySelector('.media-play').click(); await until(() => !audio.paused && audio.currentTime > .1);
  select('transcript'); const initial = audio.currentTime; await wait(150);
  assert(pager.getBoundingClientRect().top === pagerTop, 'Playback feedback must not shift the pager');
  assert(!audio.paused && audio.currentTime > initial, 'Audio must continue offscreen');
  assert(document.querySelector('.playback-status').textContent.includes(document.documentElement.lang === 'fr' ? 'Lecture audio' : document.documentElement.lang === 'es' ? 'Reproduciendo audio' : 'Playing audio'), 'Playback status must follow real audio');
  assert(content.scrollTop === 567, 'Transcript scroll must survive navigation exactly');
  select('video'); await until(() => page('video').querySelector('video')?.readyState >= 1);
  const video = page('video').querySelector('video'); video.loop = true;
  page('video').querySelector('.media-play').click(); await until(() => !video.paused && audio.paused);
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
