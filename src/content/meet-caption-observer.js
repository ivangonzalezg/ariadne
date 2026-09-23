// src/content/meet-caption-observer.js
import { SELECTORS } from "./meet-selectors.js";
import { debugLog } from "../shared/debug-log.js";

function findCaptionsContainer() {
  const regions = document.querySelectorAll('[role="region"]');
  debugLog("[Ariadne:debug] findCaptionsContainer — regiones encontradas:", regions.length);
  const captionsToggleButton = document.querySelector(SELECTORS.captionsToggleButton);
  for (const region of regions) {
    debugLog("[Ariadne:debug] findCaptionsContainer — región:", {
      id: region.id,
      ariaLabel: region.getAttribute("aria-label"),
      captionsToggle: captionsToggleButton
        ? {
            ariaControls: captionsToggleButton.getAttribute("aria-controls"),
            ariaOwns: captionsToggleButton.getAttribute("aria-owns"),
            ariaDescribedBy: captionsToggleButton.getAttribute("aria-describedby"),
          }
        : null,
    });
    if (region.querySelector(SELECTORS.captionUtteranceBlock)) return region;
  }
  debugLog("[Ariadne:debug] findCaptionsContainer — ninguna región tenía captionUtteranceBlock");
  return null;
}

function readLatestSnapshot(container) {
  const blocks = container.querySelectorAll(SELECTORS.captionUtteranceBlock);
  if (blocks.length === 0) return null;
  const latest = blocks[blocks.length - 1];

  const speakerEl = latest.querySelector(SELECTORS.captionSpeakerName);
  const textEl = latest.querySelector(SELECTORS.captionText);
  if (!textEl) return null;

  return {
    speaker: speakerEl ? speakerEl.textContent.trim() : null,
    text: textEl.textContent.trim(),
    timestampMs: Date.now(),
  };
}

function observeCaptions(onSnapshot) {
  const container = findCaptionsContainer();
  if (!container) return () => {};

  const observer = new MutationObserver(() => {
    const snapshot = readLatestSnapshot(container);
    if (snapshot) onSnapshot(snapshot);
  });

  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

function isCaptionsCurrentlyOn(button) {
  const icons = Array.from(button.querySelectorAll("i")).map((icon) => icon.textContent.trim());
  debugLog("[Ariadne:debug] isCaptionsCurrentlyOn — íconos encontrados en el botón:", icons);
  const icon = button.querySelector("i");
  const result = icon?.textContent.trim() === "closed_caption";
  debugLog("[Ariadne:debug] isCaptionsCurrentlyOn — resultado:", result);
  return result;
}

function ensureCaptionsEnabled({ retries, delayMs }) {
  return new Promise((resolve) => {
    let attemptsLeft = retries;
    const tryEnsure = () => {
      const button = document.querySelector(SELECTORS.captionsToggleButton);
      if (button) {
        const alreadyOn = isCaptionsCurrentlyOn(button);
        debugLog("[Ariadne:debug] ensureCaptionsEnabled — botón encontrado, alreadyOn:", alreadyOn);
        if (!alreadyOn) {
          button.click();
          debugLog("[Ariadne:debug] ensureCaptionsEnabled — click ejecutado");
        }
        resolve(true);
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) {
        setTimeout(tryEnsure, delayMs);
      } else {
        resolve(false);
      }
    };
    tryEnsure();
  });
}

export async function enableCaptionsAndObserve(onSnapshot, { retries = 30, delayMs = 500 } = {}) {
  if (findCaptionsContainer()) {
    return observeCaptions(onSnapshot);
  }

  await ensureCaptionsEnabled({ retries, delayMs });

  let attemptsLeft = retries;
  let cleanup = () => {};

  const tryAttach = () => {
    const container = findCaptionsContainer();
    if (container) {
      cleanup = observeCaptions(onSnapshot);
      return;
    }
    attemptsLeft -= 1;
    if (attemptsLeft > 0) setTimeout(tryAttach, delayMs);
  };
  tryAttach();

  return () => cleanup();
}
