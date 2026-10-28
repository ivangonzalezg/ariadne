import { TEAMS_SELECTORS, findVisible } from "./teams-selectors.js";

export function readTeamsMicMuted(button) {
  if (!button) return true;
  // Teams labels describe the action, not the current state. Prefer those to
  // aria-pressed, whose meaning has differed across Teams web clients.
  const label = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""}`;
  if (/\b(unmute|reactivar|activar (?:el )?(?:micr[oó]fono|audio)|r[eé]activer)\b/i.test(label)) return true;
  if (/\b(mute|silenciar|desactivar (?:el )?(?:micr[oó]fono|audio)|d[eé]sactiver)\b/i.test(label)) return false;
  const muted = button.getAttribute("data-is-muted");
  if (muted !== null) return muted === "true";
  const pressed = button.getAttribute("aria-pressed");
  return pressed === null ? true : pressed !== "true";
}

export function observeTeamsMuteState(onChange, { intervalMs = 500 } = {}) {
  let lastMuted;
  const scan = () => {
    const muted = readTeamsMicMuted(findVisible(TEAMS_SELECTORS.microphone));
    if (muted === lastMuted) return;
    lastMuted = muted;
    onChange(muted, Date.now());
  };
  // Always publish an initial state: this is what starts the MAIN recorder.
  // Polling also survives React replacing the entire microphone control.
  scan();
  const timer = setInterval(scan, intervalMs);
  return () => clearInterval(timer);
}
