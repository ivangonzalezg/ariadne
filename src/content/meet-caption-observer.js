// src/content/meet-caption-observer.js
import { SELECTORS } from "./meet-selectors.js";

function findCaptionsContainer() {
  const regions = document.querySelectorAll('[role="region"]');
  for (const region of regions) {
    if (region.querySelector(SELECTORS.captionUtteranceBlock)) return region;
  }
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
  const icon = button.querySelector("i");
  return icon?.textContent.trim() === "closed_caption";
}

function ensureCaptionsEnabled({ retries, delayMs }) {
  return new Promise((resolve) => {
    let attemptsLeft = retries;
    const tryEnsure = () => {
      const button = document.querySelector(SELECTORS.captionsToggleButton);
      if (button) {
        if (!isCaptionsCurrentlyOn(button)) {
          button.click();
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

export async function enableCaptionsAndObserve(onSnapshot, { retries = 10, delayMs = 300 } = {}) {
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
