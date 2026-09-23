// src/content/meet-selectors.js
// Meet renders Material icon names in <i> text nodes. Unlike aria-label values,
// those internal names are not localized (validated against Meet directly).
export function findByIconText(name) {
  const icons = document.querySelectorAll("i");
  for (const icon of icons) {
    if (icon.textContent.trim() === name) return icon;
  }
  return null;
}

export const SELECTORS = {
  micButton: "[data-is-muted]",
  micMutedAttribute: "data-is-muted",
  captionsToggleButton: 'button[jsname="RrG0hf"], button[jslog^="211197"]',
  captionUtteranceBlock: ".nMcdL.bj4p3b",
  captionSpeakerName: ".NWpY1d",
  captionText: ".ygicle.VbkSUe",
};
