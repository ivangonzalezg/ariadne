import { SELECTORS, isVisible } from "./meet-selectors.js";

const ENABLE_CAPTIONS = /\b(?:(?:turn on|enable|show) (?:live )?captions|(?:activar|habilitar|mostrar) (?:los )?subt[ií]tulos|(?:activer|afficher) (?:les )?sous-titres)/i;
const DISABLE_CAPTIONS = /\b(?:(?:turn off|disable|hide) (?:live )?captions|(?:desactivar|ocultar) (?:los )?subt[ií]tulos|(?:d[eé]sactiver|masquer) (?:les )?sous-titres)/i;
const CAPTIONS_MENU = /^(?:captions and translations?|subt[ií]tulos y traducci[oó]n|sous-titres et traduction)$/i;
const label = button => (button?.getAttribute("aria-label") || button?.textContent || "").trim();
const enabled = button => button && !button.disabled && button.getAttribute("aria-disabled") !== "true";

function captionActionState(button) {
  if (DISABLE_CAPTIONS.test(label(button))) return "on";
  if (ENABLE_CAPTIONS.test(label(button))) return "off";
  return "unknown";
}

function findCaptionControls() {
  const buttons = [...document.querySelectorAll("button")].filter(button =>
    button.matches(SELECTORS.captionsToggleButton) || CAPTIONS_MENU.test(label(button)) || captionActionState(button) !== "unknown"
  ).filter(isVisible);
  const menu = buttons.find(button => CAPTIONS_MENU.test(label(button))) ?? null;
  // Prefer Meet's classic direct toggle. The experimental panel is a fallback
  // for accounts where that visible control is no longer available.
  const button = buttons.find(button => button !== menu && button.matches(SELECTORS.captionsToggleButton)) ??
    buttons.find(button => captionActionState(button) !== "unknown") ?? null;
  return { button, menu };
}

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
  // The new enable action also displays closed_caption while captions are off.
  const actionState = captionActionState(button);
  if (actionState !== "unknown") return actionState;
  const icon = button?.querySelector("i")?.textContent.trim();
  if (icon === "closed_caption") return "on";
  if (icon === "closed_caption_off") return "off";
  // A linked region is evidence only if it is visible, never an arbitrary region.
  if (container && (button?.getAttribute("aria-controls") || button?.getAttribute("aria-owns") || container.querySelector(SELECTORS.captionUtteranceBlock) || !button) &&
      !container.hidden && container.getAttribute("aria-hidden") !== "true" && getComputedStyle(container).display !== "none") return "on";
  return "unknown";
}

export function createCaptionControl() {
  let pausedByUser = false, pendingUserChange = null, menuAttemptAt = -Infinity;
  const attempts = new WeakMap();
  const handleUserToggle = (event) => {
    if (!event.isTrusted) return;
    const target = event.target.closest?.("button");
    const button = target && (target.matches(SELECTORS.captionsToggleButton) ||
      CAPTIONS_MENU.test(label(target)) || captionActionState(target) !== "unknown") ? target : null;
    if (button) pendingUserChange = { button, before: captionToggleState(button, findCaptionsContainer(button)), at: Date.now() };
  };
  document.addEventListener("click", handleUserToggle, true);
  return {
    sync() {
      let { button, menu } = findCaptionControls();
      let container = findCaptionsContainer(button ?? menu), ccState = captionToggleState(button ?? menu, container);
      if (pendingUserChange) {
        if (ccState !== "unknown" && ccState !== pendingUserChange.before) {
          pausedByUser = ccState === "off"; pendingUserChange = null;
        } else if (Date.now() - pendingUserChange.at > 2000) pendingUserChange = null;
      }
      if (pausedByUser && ccState === "on") pausedByUser = false;
      if (!pausedByUser && !pendingUserChange && ccState !== "on" && !button && enabled(menu) &&
          menu.getAttribute("aria-expanded") !== "true" && Date.now() - menuAttemptAt >= 15000) {
        menuAttemptAt = Date.now(); menu.click();
        ({ button, menu } = findCaptionControls());
        // Some Meet variants reveal the actions on hover instead of click.
        if (!button && menu && captionToggleState(menu) !== "on") {
          if (typeof PointerEvent === "function") menu.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
          menu.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          menu.dispatchEvent(new MouseEvent("mouseenter"));
          ({ button, menu } = findCaptionControls());
        }
        container = findCaptionsContainer(button ?? menu); ccState = captionToggleState(button ?? menu, container);
      }
      if (!pausedByUser && !pendingUserChange && enabled(button) && ccState === "off" && Date.now() - (attempts.get(button) ?? -Infinity) >= 5000) {
        attempts.set(button, Date.now()); button.click();
        ({ button, menu } = findCaptionControls());
        container = findCaptionsContainer(button ?? menu); ccState = captionToggleState(button ?? menu, container);
      }
      return { container, ccState, pausedByUser,
        state: pausedByUser ? "paused" : ccState === "on" ? "active" : "preparing" };
    },
    dispose() { document.removeEventListener("click", handleUserToggle, true); },
    // The handler is exposed for trusted-event lifecycle tests; production uses the listener.
    handleUserToggle,
  };
}
