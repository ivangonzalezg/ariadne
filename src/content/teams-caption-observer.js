import { observePlatformCaptions } from "./caption-observer.js";
import { createTeamsCaptionControl } from "./teams-caption-control.js";
import { TEAMS_SELECTORS } from "./teams-selectors.js";

export function enableTeamsCaptionsAndObserve(onSnapshot, options = {}) {
  return observePlatformCaptions(onSnapshot, {
    ...options, selectors: TEAMS_SELECTORS, createControl: createTeamsCaptionControl, idPrefix: "teams-dom", splitOnSpeakerChange: true,
    readBlock: block => ({
      speaker: block.querySelector(TEAMS_SELECTORS.captionSpeakerName)?.textContent.trim() || null,
      text: block.querySelector(TEAMS_SELECTORS.captionText)?.textContent.trim() || "",
    }),
    // Teams virtualizes its caption list and can reuse an element for another
    // message. Never let that overwrite the previous speaker's intervention.
    getBlockKey: block => block.getAttribute("data-message-id") ?? block.getAttribute("data-item-key") ?? (block.id || null),
  });
}
