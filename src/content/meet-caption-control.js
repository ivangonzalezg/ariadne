import { SELECTORS } from "./meet-selectors.js";

export function findCaptionsContainer(button) {
  for (const attribute of ["aria-controls", "aria-owns"]) {
    for (const id of button?.getAttribute(attribute)?.trim().split(/\s+/) ?? []) {
      const target = document.getElementById(id);
      if (target?.matches('[role="region"]')) return target;
      const region = target?.querySelector('[role="region"]');
      if (region) return region;
    }
  }
  return [...document.querySelectorAll('[role="region"]')].find((region) => region.querySelector(SELECTORS.captionUtteranceBlock)) ?? null;
}

export function captionToggleState(button, container) {
  const pressed = button?.getAttribute("aria-pressed");
  if (pressed === "true") return "on";
  if (pressed === "false") return "off";
  const icon = button?.querySelector("i")?.textContent.trim();
  if (icon === "closed_caption") return "on";
  if (icon === "closed_caption_off") return "off";
  // A linked region is evidence only if it is visible, never an arbitrary region.
  if (container && (button?.getAttribute("aria-controls") || button?.getAttribute("aria-owns") || container.querySelector(SELECTORS.captionUtteranceBlock) || !button) &&
      !container.hidden && container.getAttribute("aria-hidden") !== "true" && getComputedStyle(container).display !== "none") return "on";
  return "unknown";
}

export function createCaptionControl() {
  let pausedByUser = false, pendingUserChange = null;
  const attempts = new WeakMap();
  const handleUserToggle = (event) => {
    if (!event.isTrusted) return;
    const button = event.target.closest?.(SELECTORS.captionsToggleButton);
    if (button) pendingUserChange = { button, before: captionToggleState(button, findCaptionsContainer(button)), at: Date.now() };
  };
  document.addEventListener("click", handleUserToggle, true);
  return {
    sync() {
      const button = document.querySelector(SELECTORS.captionsToggleButton);
      let container = findCaptionsContainer(button), ccState = captionToggleState(button, container);
      if (pendingUserChange) {
        if (ccState !== "unknown" && ccState !== pendingUserChange.before) {
          pausedByUser = ccState === "off"; pendingUserChange = null;
        } else if (Date.now() - pendingUserChange.at > 2000) pendingUserChange = null;
      }
      if (pausedByUser && ccState === "on") pausedByUser = false;
      if (!pausedByUser && !pendingUserChange && button && ccState === "off" && Date.now() - (attempts.get(button) ?? -Infinity) >= 5000) {
        attempts.set(button, Date.now()); button.click();
        container = findCaptionsContainer(button); ccState = captionToggleState(button, container);
      }
      return { container, ccState, pausedByUser,
        state: pausedByUser ? "paused" : ccState === "on" ? "active" : "preparing" };
    },
    dispose() { document.removeEventListener("click", handleUserToggle, true); },
    // The handler is exposed for trusted-event lifecycle tests; production uses the listener.
    handleUserToggle,
  };
}
