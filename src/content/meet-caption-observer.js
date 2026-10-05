import { isOwnCaptionLabel } from "./meet-local-identity.js";
import { SELECTORS } from "./meet-selectors.js";
import { createCaptionControl } from "./meet-caption-control.js";

const readBlock = (block) => ({ speaker: block.querySelector(SELECTORS.captionSpeakerName)?.textContent.trim() || null,
  text: block.querySelector(SELECTORS.captionText)?.textContent.trim() || "" });
const signature = (snapshot) => JSON.stringify([snapshot.speaker, snapshot.text]);

export function enableCaptionsAndObserve(onSnapshot, { delayMs = 500, onActiveChange = () => {}, onStatus = () => {} } = {}) {
  const control = createCaptionControl(), identities = new WeakMap();
  let container = null, observer = null, stopped = false, active = null, status = null, nextId = 0, lastReceivedAt = null, reportedStatus = null;
  const baseline = new WeakSet();
  const initial = control.sync();
  for (const block of initial.container?.querySelectorAll(SELECTORS.captionUtteranceBlock) ?? []) baseline.add(block);

  const captureBlock = (block, aliases = null) => {
    const snapshot = readBlock(block);
    let entry = identities.get(block);
    if (!entry) {
      const matches = aliases?.get(signature(snapshot)) ?? [];
      entry = matches.length === 1 ? matches.pop() : { utteranceId: `dom-${++nextId}`, revision: 0, firstReceivedAt: null,
        snapshot: baseline.has(block) ? snapshot : null };
      identities.set(block, entry);
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
      for (const block of node.querySelectorAll(SELECTORS.captionUtteranceBlock)) captureBlock(block);
    }
  };
  const capture = (records = []) => {
    if (stopped) return;
    for (const record of records) { readNodes(record.removedNodes ?? []); readNodes(record.addedNodes ?? []); }
    for (const block of container?.querySelectorAll(SELECTORS.captionUtteranceBlock) ?? []) captureBlock(block);
  };
  const sync = () => {
    if (stopped) return;
    const next = control.sync(); status = next;
    if (next.container !== container) {
      capture(observer?.takeRecords() ?? []);
      const aliases = new Map();
      for (const block of container?.querySelectorAll(SELECTORS.captionUtteranceBlock) ?? []) {
        const entry = identities.get(block);
        if (!entry?.snapshot) continue;
        const key = signature(entry.snapshot);
        if (!aliases.has(key)) aliases.set(key, []);
        aliases.get(key).push(entry);
      }
      // Both sides must be unique; repeated phrases are separate interventions.
      const newCounts = new Map();
      for (const block of next.container?.querySelectorAll(SELECTORS.captionUtteranceBlock) ?? []) {
        const key = signature(readBlock(block)); newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of newCounts) if (count !== 1) aliases.delete(key);
      observer?.disconnect(); container = next.container;
      if (container) {
        for (const block of container.querySelectorAll(SELECTORS.captionUtteranceBlock)) captureBlock(block, aliases);
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
