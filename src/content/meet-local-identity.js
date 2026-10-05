// These anchors were checked on both the host and guest tabs of a real Meet.
// Camera controls identify the local tile even while camera/microphone are off.
export function readLocalIdentity(root = document) {
  const candidates = new Map();
  for (const tile of root.querySelectorAll('[data-participant-id]')) {
    const id = tile.getAttribute('data-participant-id');
    if (!id || tile.getAttribute('data-tile-media-id') !== id) continue;
    const icons = [...tile.querySelectorAll('button i')].map(el => el.textContent.trim());
    if (!['frame_person', 'visual_effects'].every(icon => icons.includes(icon))) continue;
    const names = new Set([...tile.querySelectorAll('[jscontroller="sMwcOc"] [jsslot] span.notranslate')]
      .map(el => el.textContent.trim()).filter(Boolean));
    if (names.size !== 1 || [...names][0].length > 200) return null;
    const name = [...names][0];
    if (candidates.has(id) && candidates.get(id) !== name) return null;
    candidates.set(id, name);
  }
  if (candidates.size !== 1) return null;
  const [speakerId, name] = [...candidates][0];
  return { speakerId, name, evidence: 'meet-own-camera-controls' };
}

export function observeLocalIdentity(onIdentity, { intervalMs = 500 } = {}) {
  let identity = null, stopped = false;
  const scan = () => {
    if (stopped) return;
    const next = readLocalIdentity();
    // Disappearing tiles do not revoke a verified identity. A different device
    // within this recording is ambiguous; never silently switch participants.
    if (!next || (identity && identity.speakerId !== next.speakerId)) return;
    if (JSON.stringify(identity) === JSON.stringify(next)) return;
    identity = next; onIdentity(next);
  };
  const timer = setInterval(scan, intervalMs); scan();
  const stop = () => { stopped = true; clearInterval(timer); };
  stop.flush = scan;
  return stop;
}

export function isOwnCaptionLabel(speaker, language = document.documentElement.lang) {
  const labels = { en: ['You'], es: ['Tú', 'Tu'], fr: ['Vous'] };
  return (labels[language.toLowerCase().split('-')[0]] ?? []).includes(speaker);
}
