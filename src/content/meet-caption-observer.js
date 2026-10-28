import { isOwnCaptionLabel } from "./meet-local-identity.js";
import { SELECTORS } from "./meet-selectors.js";
import { createCaptionControl } from "./meet-caption-control.js";
import { observePlatformCaptions } from "./caption-observer.js";

export function enableCaptionsAndObserve(onSnapshot, options = {}) {
  return observePlatformCaptions(onSnapshot, {
    ...options, selectors: SELECTORS, createControl: createCaptionControl, isOwnCaptionLabel,
    readBlock: block => ({
      speaker: block.querySelector(SELECTORS.captionSpeakerName)?.textContent.trim() || null,
      text: block.querySelector(SELECTORS.captionText)?.textContent.trim() || "",
    }),
  });
}
