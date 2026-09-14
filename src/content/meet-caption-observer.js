// src/content/meet-caption-observer.js
import { SELECTORS } from "./meet-selectors.js";

function findCaptionsContainer() {
  return document.querySelector(SELECTORS.captionsContainer);
}

function readCurrentSnapshot(container) {
  const speakerEl = container.querySelector(SELECTORS.captionSpeakerName) ?? null;
  const textEl = container.querySelector(SELECTORS.captionText);
  if (!textEl) return null;

  return {
    speaker: speakerEl ? speakerEl.textContent.trim() : null,
    text: textEl.textContent.trim(),
    timestampMs: Date.now(),
  };
}

export function observeCaptions(onSnapshot) {
  const container = findCaptionsContainer();
  if (!container) return () => {};

  const observer = new MutationObserver(() => {
    const snapshot = readCurrentSnapshot(container);
    if (snapshot) onSnapshot(snapshot);
  });

  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

export function enableCaptionsAndObserve(onSnapshot, { retries = 10, delayMs = 300 } = {}) {
  if (findCaptionsContainer()) {
    return observeCaptions(onSnapshot);
  }

  let attemptsLeft = retries;
  let cleanup = () => {};

  const tryAttach = () => {
    const container = findCaptionsContainer();
    if (container) {
      cleanup = observeCaptions(onSnapshot);
      return;
    }
    document.querySelector(SELECTORS.captionsToggleButton)?.click();
    attemptsLeft -= 1;
    if (attemptsLeft > 0) setTimeout(tryAttach, delayMs);
  };
  tryAttach();

  return () => cleanup();
}
