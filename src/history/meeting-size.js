import { meetingCleanupChecked } from "../storage/meeting-cleanup-state.js";

export function createMeetingSizes({ list, measure, format, unavailable }) {
  let cache = new Map();
  let running = false;
  const pending = new Map();
  const folders = new WeakMap();
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.target.isConnected) pending.set(entry.target, folders.get(entry.target));
      else pending.delete(entry.target);
    }
    void drain();
  }, { root: list }) : null;

  function show(element, bytes) {
    element.textContent = bytes === null ? unavailable : format(bytes);
    element.title = element.textContent;
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      for (const [element, meeting] of pending) {
        pending.delete(element);
        if (!element.isConnected) continue;
        observer?.unobserve(element);
        const folder = meeting.folderName;
        const results = cache;
        if (!results.has(folder)) {
          try {
            results.set(folder, await measure(meeting));
          } catch {
            results.set(folder, null);
          }
        }
        const bytes = results.get(folder);
        if (bytes !== undefined && element.isConnected && cache === results) show(element, bytes);
      }
    } finally {
      running = false;
    }
  }

  return {
    add(element, meeting) {
      const folder = meeting.folderName;
      if (meeting.processing?.pending) return;
      if (meetingCleanupChecked(meeting) && Number.isSafeInteger(meeting.diskSize?.bytes) && meeting.diskSize.bytes >= 0 &&
          meeting.diskSize.revision === (meeting.processing?.revision ?? null)) {
        show(element, meeting.diskSize.bytes);
      } else if (!folder) {
        show(element, null);
      } else if (cache.has(folder)) {
        if (cache.get(folder) !== undefined) show(element, cache.get(folder));
      } else if (observer) {
        folders.set(element, meeting);
        observer.observe(element);
      } else {
        pending.set(element, meeting);
        queueMicrotask(drain);
      }
    },
    clearCards() {
      observer?.disconnect();
      pending.clear();
    },
    invalidate() { cache = new Map(); },
  };
}
