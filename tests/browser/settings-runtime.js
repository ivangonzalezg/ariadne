const params = new URLSearchParams(location.search);
Object.defineProperty(navigator, 'language', { value: params.get('locale') || 'en' });
const values = { videoPreset: 'medium', debugLogging: false, minimumMeetingDurationSeconds: 0 };
let finishSave, failSave = false;
window.chrome = {
  runtime: { getURL: path => '/' + path },
  storage: { local: { get: async defaults => ({ ...defaults, ...values }), set: async data => {
    if (failSave) { failSave = false; throw new Error('Fixture failure'); }
    if ('debugLogging' in data) await new Promise(resolve => { finishSave = resolve; });
    Object.assign(values, data);
  } } },
};
await import('../../src/settings/settings.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('Settings timeout'); await wait(20); } }
window.runSettingsTest = async () => {
  const toggle = document.querySelector('#debug-logging');
  await until(() => !toggle.disabled);
  const knob = toggle.firstElementChild; toggle.click();
  assert(toggle.disabled && toggle.getAttribute('aria-checked') === 'true', 'Switch must respond immediately and block pending writes');
  toggle.click(); finishSave(); await until(() => !toggle.disabled);
  assert(values.debugLogging && toggle.firstElementChild === knob, 'Switch must persist without replacing its knob');
  const preset = document.querySelector('#video-preset'); failSave = true; preset.value = 'fast'; preset.dispatchEvent(new Event('change'));
  await until(() => !preset.disabled);
  assert(preset.value === 'medium' && preset.closest('.setting-card').querySelector('.setting-status').classList.contains('is-error'), 'Failed preference must roll back with feedback');
  preset.closest('.setting-card').querySelector('.retry-setting').click(); await until(() => !preset.disabled);
  assert(preset.value === 'fast' && values.videoPreset === 'fast', 'Retry must persist requested value');
  await wait(260);
  assert(getComputedStyle(knob).transform.includes('18'), 'Switch must use actual translation');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) assert(getComputedStyle(knob).transitionDuration === '0s', 'Reduced motion must disable knob movement animation');
  return { passed: true, locale: document.documentElement.lang, screen: 'settings' };
};
window.prepareSettingsKeyboard = () => document.querySelector('#debug-logging').focus();
window.finishSettingsKeyboard = async () => {
  const toggle = document.querySelector('#debug-logging');
  assert(toggle.getAttribute('aria-checked') === 'false' && toggle.disabled, 'Space must activate the native switch');
  finishSave(); await until(() => !toggle.disabled);
  assert(values.debugLogging === false, 'Keyboard switch value must persist');
  return true;
};
