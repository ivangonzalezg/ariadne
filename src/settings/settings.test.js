import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../shared/i18n/i18n.js', () => ({ initI18n: async () => ({ t: key => key }) }));
const html = readFileSync('src/settings/settings.html', 'utf8');
const defaults = { videoPreset: 'medium', debugLogging: false, minimumMeetingDurationSeconds: 0 };
let storage;
const control = id => document.getElementById(id);
const change = id => control(id).dispatchEvent(new Event('change', { bubbles: true }));
const status = id => control(`${id}-status`);
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
async function mount(get = async values => values) {
  storage = { get: vi.fn(get), set: vi.fn().mockResolvedValue(undefined) };
  globalThis.chrome = { storage: { local: storage } };
  await import('./settings.js'); await tick();
}
beforeEach(() => { vi.resetModules(); document.documentElement.innerHTML = html; });
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); });

it('loads each preference independently and preserves switch identity', async () => {
  await mount();
  expect(storage.get).toHaveBeenCalledTimes(3);
  const toggle = control('debug-logging'); const knob = toggle.firstElementChild;
  toggle.click(); await tick();
  expect(storage.set).toHaveBeenCalledWith({ debugLogging: true });
  expect(toggle.getAttribute('aria-checked')).toBe('true'); expect(toggle.firstElementChild).toBe(knob);
});
it('blocks repeated writes without blocking other preferences and confirms success for two seconds', async () => {
  await mount(); vi.useFakeTimers();
  let finish; storage.set.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  control('video-preset').value = 'fast'; change('video-preset'); change('video-preset');
  expect(control('video-preset').disabled).toBe(true); expect(control('debug-logging').disabled).toBe(false);
  expect(status('video-preset').textContent).toBe('settings.saving'); expect(storage.set).toHaveBeenCalledTimes(1);
  finish(); await tick(); expect(control('video-preset').disabled).toBe(false); expect(status('video-preset').textContent).toBe('settings.saved');
  await vi.advanceTimersByTimeAsync(1999); expect(status('video-preset').textContent).toBe('settings.saved');
  await vi.advanceTimersByTimeAsync(1); expect(status('video-preset').textContent).toBe('');
});
it('rolls back failed writes and retries the requested value', async () => {
  await mount(); storage.set.mockRejectedValueOnce(new Error('Storage failed'));
  control('debug-logging').click(); await tick();
  expect(control('debug-logging').getAttribute('aria-checked')).toBe('false'); expect(control('debug-logging').disabled).toBe(false);
  expect(status('debug-logging').textContent).toBe('settings.saveError');
  control('debug-logging').closest('.setting-card').querySelector('.retry-setting').click(); await tick();
  expect(storage.set).toHaveBeenCalledTimes(2); expect(control('debug-logging').getAttribute('aria-checked')).toBe('true');
});
it('keeps an unread preference disabled after a load failure and recovers through retry', async () => {
  let fail = true;
  await mount(async values => { if ('videoPreset' in values && fail) throw new Error('Read failed'); return values; });
  expect(control('video-preset').disabled).toBe(true); expect(control('debug-logging').disabled).toBe(false);
  expect(status('video-preset').textContent).toBe('settings.loadError');
  fail = false; control('video-preset').closest('.setting-card').querySelector('.retry-setting').click(); await tick();
  expect(control('video-preset').disabled).toBe(false); expect(control('video-preset').value).toBe(defaults.videoPreset);
});
it('does not write invalid durations and restores the prior duration on failure', async () => {
  await mount(); control('minimum-meeting-duration').value = '-1'; change('minimum-meeting-duration'); expect(storage.set).not.toHaveBeenCalled();
  storage.set.mockRejectedValueOnce(new Error('Write failed'));
  control('minimum-meeting-duration').value = '45'; change('minimum-meeting-duration'); await tick();
  expect(storage.set).toHaveBeenCalledWith({ minimumMeetingDurationSeconds: 45 });
  expect(control('minimum-meeting-duration').value).toBe('0');
});
