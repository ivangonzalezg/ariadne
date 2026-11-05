import { findByIconText } from "./meet-selectors.js";
import { isRendered } from "./element-visibility.js";

const EXIT_CONFIRMATION_MS = 3000;
const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';

function renderedModals() {
  return [...document.querySelectorAll(MODAL_SELECTOR)].filter(isRendered);
}

function isMeetHangupControl(element) {
  return element.matches('button, [role="button"]') &&
    [...element.querySelectorAll("i")].some(icon => icon.textContent.trim() === "call_end" && isRendered(icon));
}

export function isInActiveMeeting() {
  return findByIconText("call_end", { visible: true, visibilityCheck: isRendered }) !== null;
}

// Keep observing through idle, capture finalization and rejoining the same URL.
export function observeMeetingPresence(onChange, { isActive = isInActiveMeeting, isHangupControl = isMeetHangupControl } = {}) {
  let previous;
  let scheduled = false;
  let disposed = false;
  let exitTimer = null;
  let hangup = null;
  let intentTimer;
  let clickCheck;
  const clearHangup = () => {
    clearTimeout(intentTimer);
    hangup = null;
  };
  const cancelExit = () => {
    clearTimeout(exitTimer);
    exitTimer = null;
  };
  const publish = active => {
    cancelExit();
    clearHangup();
    previous = active;
    onChange(active);
  };
  const check = (confirmExit = false) => {
    scheduled = false;
    if (disposed) return;
    const active = isActive();
    if (hangup) {
      const modalOpen = renderedModals().some(modal => !hangup.existingModals.has(modal));
      if (modalOpen && (hangup.awaitingDialog || Date.now() <= hangup.deadline)) {
        hangup.awaitingDialog = true;
        cancelExit();
        return;
      }
      if (!active && !hangup.control.isConnected && (hangup.awaitingDialog || Date.now() <= hangup.deadline)) {
        publish(false);
        return;
      }
      if (hangup.awaitingDialog || Date.now() >= hangup.deadline || (active && !hangup.control.isConnected)) clearHangup();
    }
    if (active) cancelExit();
    if (active === previous) return;
    if (!active && previous === true && !confirmExit) {
      if (exitTimer === null) exitTimer = setTimeout(() => {
        exitTimer = null;
        check(true);
      }, EXIT_CONFIRMATION_MS);
      return;
    }
    publish(active);
  };
  const onClick = event => {
    if (!event.isTrusted || previous !== true) return;
    const control = event.composedPath().find(node => node instanceof Element && isHangupControl(node));
    if (!control || !isRendered(control) || control.matches(':disabled, [aria-disabled="true"]') || !isActive()) return;
    clearHangup();
    hangup = {
      control, existingModals: new Set(renderedModals()), deadline: Date.now() + EXIT_CONFIRMATION_MS,
      awaitingDialog: false,
    };
    intentTimer = setTimeout(() => check(), EXIT_CONFIRMATION_MS);
    // Run after page click handlers, even if they don't mutate the document.
    clearTimeout(clickCheck);
    clickCheck = setTimeout(() => check(), 0);
  };
  document.addEventListener("click", onClick, true);
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(check);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "aria-modal", "open", "class", "style"] });
  const timer = setInterval(() => check(), 3000);
  check();
  return () => {
    disposed = true;
    document.removeEventListener("click", onClick, true);
    observer.disconnect();
    clearInterval(timer);
    clearTimeout(clickCheck);
    cancelExit();
    clearHangup();
  };
}
