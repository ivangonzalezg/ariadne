import { findByIconText } from "./meet-selectors.js";
import { isRendered } from "./element-visibility.js";

const EXIT_CONFIRMATION_MS = 3000;

export function isInActiveMeeting() {
  return findByIconText("call_end", { visible: true, visibilityCheck: isRendered }) !== null;
}

// Keep observing through idle, capture finalization and rejoining the same URL.
export function observeMeetingPresence(onChange, { isActive = isInActiveMeeting } = {}) {
  let previous;
  let scheduled = false;
  let disposed = false;
  let exitTimer = null;
  const cancelExit = () => {
    clearTimeout(exitTimer);
    exitTimer = null;
  };
  const check = () => {
    scheduled = false;
    if (disposed) return;
    const active = isActive();
    if (active) cancelExit();
    if (!active && previous === true) {
      if (exitTimer === null) exitTimer = setTimeout(() => {
        exitTimer = null;
        if (disposed) return;
        if (isActive()) return;
        previous = false;
        onChange(false);
      }, EXIT_CONFIRMATION_MS);
      return;
    }
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
  return () => { disposed = true; observer.disconnect(); clearInterval(timer); cancelExit(); };
}
