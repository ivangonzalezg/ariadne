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

function observeCaptions(onSnapshot) {
  const container = findCaptionsContainer();
  if (!container) return () => {};

  const observer = new MutationObserver(() => {
    const snapshot = readCurrentSnapshot(container);
    if (snapshot) onSnapshot(snapshot);
  });

  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

const HIDE_STYLE_ID = "asterion-hide-captions";

function hideCaptionsVisually() {
  if (document.getElementById(HIDE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIDE_STYLE_ID;
  // opacity + pointer-events en vez de display:none/visibility:hidden — Meet deja
  // de actualizar el DOM de subtítulos si el contenedor no es visible, lo que
  // rompería el MutationObserver.
  style.textContent = `${SELECTORS.captionsContainer} { opacity: 0 !important; pointer-events: none !important; }`;
  document.head.appendChild(style);
}

function clickCaptionsToggleOnceReady({ retries, delayMs }) {
  return new Promise((resolve) => {
    let attemptsLeft = retries;
    const tryClick = () => {
      const button = document.querySelector(SELECTORS.captionsToggleButton);
      if (button) {
        button.click();
        resolve(true);
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) {
        setTimeout(tryClick, delayMs);
      } else {
        resolve(false);
      }
    };
    tryClick();
  });
}

export async function enableCaptionsAndObserve(onSnapshot, { retries = 10, delayMs = 300 } = {}) {
  hideCaptionsVisually();

  if (findCaptionsContainer()) {
    return observeCaptions(onSnapshot);
  }

  // Clic una sola vez (reintentando solo hasta que el botón exista en el DOM,
  // no repitiendo el clic después de haber tenido éxito — antes esto podía volver
  // a apagar los subtítulos si el contenedor tardaba en aparecer).
  await clickCaptionsToggleOnceReady({ retries, delayMs });

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
