import { findByIconText } from "./meet-selectors.js";

export function isInActiveMeeting() {
  return findByIconText("call_end", { visible: true }) !== null;
}

// Keep observing through idle, capture finalization and rejoining the same URL.
export function observeMeetingPresence(onChange, { isActive = isInActiveMeeting } = {}) {
  let previous;
  let scheduled = false;
  let disposed = false;
  const check = () => {
    scheduled = false;
    if (disposed) return;
    const active = isActive();
    if (active === previous) return;
    previous = active;
    onChange(active);
  };
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(check);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "class", "style"] });
  const timer = setInterval(check, 3000);
  check();
  return () => { disposed = true; observer.disconnect(); clearInterval(timer); };
}
