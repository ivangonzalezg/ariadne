const signature = (snapshot) => JSON.stringify([snapshot.speaker, snapshot.text]);

// Shared lifecycle only; each platform supplies its DOM selectors and controls.
export function observePlatformCaptions(onSnapshot, { selectors: SELECTORS, createControl, readBlock,
  isOwnCaptionLabel = () => false, getBlockKey = () => null, splitOnSpeakerChange = false, idPrefix = "dom",
  delayMs = 500, onActiveChange = () => {}, onStatus = () => {} }) {
  const control = createControl(), identities = new WeakMap();
  const blocksIn = root => [...root?.querySelectorAll(SELECTORS.captionUtteranceBlock) ?? []]
    .filter(block => !block.parentElement?.closest(SELECTORS.captionUtteranceBlock));
  let container = null, observer = null, stopped = false, active = null, status = null, nextId = 0, lastReceivedAt = null, reportedStatus = null;
  const baseline = new WeakMap();
  const initial = control.sync();
  for (const block of blocksIn(initial.container)) baseline.set(block, getBlockKey(block, readBlock(block)));

  const captureBlock = (block, aliases = null) => {
    if (block.parentElement?.closest(SELECTORS.captionUtteranceBlock)) return;
    const snapshot = readBlock(block);
    let entry = identities.get(block);
    const blockKey = getBlockKey(block, snapshot);
    if (entry && (entry.blockKey !== blockKey || (splitOnSpeakerChange && entry.snapshot?.speaker && snapshot.speaker && entry.snapshot.speaker !== snapshot.speaker))) entry = null;
    if (!entry) {
      const matches = aliases?.get(JSON.stringify([blockKey, signature(snapshot)])) ?? [];
      entry = matches.length === 1 ? matches.pop() : { utteranceId: `${idPrefix}-${++nextId}`, revision: 0, firstReceivedAt: null,
        snapshot: baseline.has(block) && baseline.get(block) === blockKey ? snapshot : null };
      entry.blockKey = blockKey;
      identities.set(block, entry);
      baseline.delete(block);
    }
    if (!snapshot.text || signature(snapshot) === (entry.snapshot && signature(entry.snapshot))) return;
    entry.snapshot = snapshot;
    if (status?.state !== "active") return;
    const now = Date.now(); entry.firstReceivedAt ??= now; entry.revision++;
    lastReceivedAt = now;
    onSnapshot({ source: "dom", utteranceId: entry.utteranceId, revision: entry.revision, speakerId: null,
      ...snapshot, originalSpeaker: snapshot.speaker, isSelf: isOwnCaptionLabel(snapshot.speaker), firstReceivedAt: entry.firstReceivedAt, updatedAt: now });
  };
  const readNodes = (nodes) => {
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches(SELECTORS.captionUtteranceBlock)) captureBlock(node);
      for (const block of blocksIn(node)) captureBlock(block);
    }
  };
  const capture = (records = []) => {
    if (stopped) return;
    for (const record of records) { readNodes(record.removedNodes ?? []); readNodes(record.addedNodes ?? []); }
    for (const block of blocksIn(container)) captureBlock(block);
  };
  const sync = () => {
    if (stopped) return;
    const next = control.sync(); status = next;
    if (next.container !== container) {
      capture(observer?.takeRecords() ?? []);
      const aliases = new Map();
      for (const block of blocksIn(container)) {
        const entry = identities.get(block);
        if (!entry?.snapshot) continue;
        const key = JSON.stringify([entry.blockKey, signature(entry.snapshot)]);
        if (!aliases.has(key)) aliases.set(key, []);
        aliases.get(key).push(entry);
      }
      // Both sides must be unique; repeated phrases are separate interventions.
      const newCounts = new Map();
      for (const block of blocksIn(next.container)) {
        const snapshot = readBlock(block);
        const key = JSON.stringify([getBlockKey(block, snapshot), signature(snapshot)]);
        newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of newCounts) if (count !== 1) aliases.delete(key);
      observer?.disconnect(); container = next.container;
      if (container) {
        for (const block of blocksIn(container)) captureBlock(block, aliases);
        observer = new MutationObserver(capture);
        observer.observe(container, { childList: true, subtree: true, characterData: true });
      } else observer = null;
    }
    const enabled = next.state === "active";
    if (enabled !== active) { active = enabled; onActiveChange(enabled); }
    capture();
    const summary = { state: next.state, ccState: next.ccState, panel: Boolean(container), lastReceivedAt };
    if (JSON.stringify(summary) !== reportedStatus) { reportedStatus = JSON.stringify(summary); onStatus(summary); }
  };
  const interval = setInterval(sync, delayMs); sync();
  const cleanup = () => {
    if (stopped) return;
    capture(observer?.takeRecords() ?? []); stopped = true;
    clearInterval(interval); observer?.disconnect(); control.dispose(); onActiveChange(false);
  };
  cleanup.flush = () => { sync(); capture(observer?.takeRecords() ?? []); };
  cleanup.getStatus = () => status;
  return cleanup;
}
