// src/content/meet-mute-observer.js
import { SELECTORS } from "./meet-selectors.js";

function isMicButtonMuted(button) {
  return button.getAttribute(SELECTORS.micMutedAttribute) === "true";
}

export function observeMuteState(onChange) {
  const micButton = document.querySelector(SELECTORS.micButton);
  if (!micButton) return () => {};

  let lastMuted = isMicButtonMuted(micButton);
  onChange(lastMuted, Date.now());

  const observer = new MutationObserver(() => {
    const muted = isMicButtonMuted(micButton);
    if (muted !== lastMuted) {
      lastMuted = muted;
      onChange(muted, Date.now());
    }
  });

  observer.observe(micButton, { attributes: true });
  return () => observer.disconnect();
}
