import { afterEach, expect, it, vi } from 'vitest';
import { readLocalIdentity, observeLocalIdentity, isOwnCaptionLabel } from './meet-local-identity.js';
const tile = (id, name, own = true, media = id) => `<div data-participant-id="${id}" data-tile-media-id="${media}">
  ${own ? '<button><i>frame_person</i></button><button><i>visual_effects</i></button>' : ''}
  <div jscontroller="sMwcOc"><div jsslot><span class="notranslate">${name}</span></div></div></div>`;
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });
it('resolves host and guest from their own controls, independent of tile order', () => {
  document.body.innerHTML = tile('guest', 'Guest', false) + tile('ivan', 'Iván González');
  expect(readLocalIdentity()).toMatchObject({ speakerId: 'ivan', name: 'Iván González' });
  document.body.innerHTML = tile('ivan', 'Iván González', false) + tile('guest', 'Guest');
  expect(readLocalIdentity()).toMatchObject({ speakerId: 'guest', name: 'Guest' });
});
it('rejects ambiguous devices, names and presentation tiles', () => {
  document.body.innerHTML = tile('a', 'Same') + tile('b', 'Same'); expect(readLocalIdentity()).toBeNull();
  document.body.innerHTML = tile('a', 'Name', true, 'presentation'); expect(readLocalIdentity()).toBeNull();
  document.body.innerHTML = tile('a', 'Name');
  document.querySelector('[jsslot]').insertAdjacentHTML('beforeend', '<span class="notranslate">Other</span>');
  expect(readLocalIdentity()).toBeNull();
});
it('keeps searching during silence, caches hidden tiles and resets in a new observer', async () => {
  vi.useFakeTimers(); const onIdentity = vi.fn(), stop = observeLocalIdentity(onIdentity);
  await vi.advanceTimersByTimeAsync(300000); expect(onIdentity).not.toHaveBeenCalled();
  document.body.innerHTML = tile('a', 'Ana'); await vi.advanceTimersByTimeAsync(500);
  document.body.innerHTML = ''; await vi.advanceTimersByTimeAsync(500); expect(onIdentity).toHaveBeenCalledOnce();
  document.body.innerHTML = tile('b', 'Beto'); await vi.advanceTimersByTimeAsync(500); expect(onIdentity).toHaveBeenCalledOnce();
  stop(); const second = observeLocalIdentity(onIdentity); expect(onIdentity).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Beto' })); second();
});
it('recognizes self labels only in the interface language', () => {
  expect(isOwnCaptionLabel('You', 'en-US')).toBe(true); expect(isOwnCaptionLabel('Tú', 'es')).toBe(true);
  expect(isOwnCaptionLabel('Vous', 'fr')).toBe(true); expect(isOwnCaptionLabel('You', 'es')).toBe(false);
  expect(isOwnCaptionLabel('Iván', 'en')).toBe(false);
});
