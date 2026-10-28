import { TEAMS_SELECTORS, findVisible, isVisible } from "./teams-selectors.js";

const OFF_ACTION = /(?:turn on|show|enable) (?:live )?captions|(?:activar|mostrar|habilitar) (?:los )?subt[ií]tulos|(?:activer|afficher) (?:les )?sous-titres/i;
const ON_ACTION = /(?:turn off|hide|disable) (?:live )?captions|(?:desactivar|ocultar) (?:los )?subt[ií]tulos|(?:d[eé]sactiver|masquer) (?:les )?sous-titres/i;
const SPEECH_MENU = /language and speech|idioma y voz|idioma y habla|langue et (?:parole|voix)/i;
const label = element => `${element?.getAttribute("aria-label") ?? ""} ${element?.textContent ?? ""}`.trim();
const menuItems = () => [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')].filter(isVisible);

export function findTeamsCaptionToggle() {
  return findVisible(TEAMS_SELECTORS.captionsToggle) ?? menuItems().find(item => OFF_ACTION.test(label(item)) || ON_ACTION.test(label(item))) ?? null;
}

export function teamsCaptionState(button, container) {
  for (const attribute of ["aria-checked", "aria-pressed"]) {
    if (button?.getAttribute(attribute) === "true") return "on";
    if (button?.getAttribute(attribute) === "false") return "off";
  }
  if (ON_ACTION.test(label(button))) return "on";
  if (OFF_ACTION.test(label(button))) return "off";
  return isVisible(container) ? "on" : "unknown";
}

export function createTeamsCaptionControl() {
  let pausedByUser = false, pendingUserChange = null, menuAttemptAt = -Infinity, openingMenu = false;
  const attempts = new WeakMap();
  const handleUserToggle = event => {
    if (!event.isTrusted) return;
    const button = findTeamsCaptionToggle();
    if (button && (event.target === button || button.contains(event.target))) {
      pendingUserChange = { before: teamsCaptionState(button, findVisible(TEAMS_SELECTORS.captionsContainer)), at: Date.now() };
    }
  };
  document.addEventListener("click", handleUserToggle, true);
  return {
    sync() {
      let container = findVisible(TEAMS_SELECTORS.captionsContainer);
      const button = findTeamsCaptionToggle();
      let ccState = teamsCaptionState(button, container);
      if (pendingUserChange) {
        if (ccState !== pendingUserChange.before && ccState !== "unknown") {
          pausedByUser = ccState === "off"; pendingUserChange = null;
        } else if (pendingUserChange.before === "on" && !container && !button) {
          pausedByUser = true; pendingUserChange = null;
        } else if (Date.now() - pendingUserChange.at > 2000) pendingUserChange = null;
      }
      if (pausedByUser && ccState === "on") pausedByUser = false;
      if (!pausedByUser && !pendingUserChange && ccState !== "on") {
        if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
          if (Date.now() - (attempts.get(button) ?? -Infinity) >= 5000) {
            attempts.set(button, Date.now()); button.click(); openingMenu = false;
            container = findVisible(TEAMS_SELECTORS.captionsContainer);
            ccState = teamsCaptionState(findTeamsCaptionToggle(), container);
          }
        } else if (!button) {
          // Captions may live inside More > Language and speech. Do not close
          // a menu the user already has open, or repeatedly steal their menu.
          const items = menuItems();
          const speech = items.find(item => SPEECH_MENU.test(label(item)));
          if (openingMenu && Date.now() - menuAttemptAt > 5000) openingMenu = false;
          if (speech && openingMenu && speech.getAttribute("aria-expanded") !== "true" && !attempts.has(speech)) {
            attempts.set(speech, Date.now()); speech.click();
          } else if (!items.length && !openingMenu && Date.now() - menuAttemptAt >= 15000) {
            const more = findVisible(TEAMS_SELECTORS.more);
            if (more && !more.disabled && more.getAttribute("aria-expanded") !== "true") {
              menuAttemptAt = Date.now(); openingMenu = true; more.click();
            }
          }
        }
      }
      return { container, ccState, pausedByUser, state: pausedByUser ? "paused" : ccState === "on" ? "active" : "preparing" };
    },
    dispose() { document.removeEventListener("click", handleUserToggle, true); },
    handleUserToggle,
  };
}
