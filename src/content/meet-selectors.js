// src/content/meet-selectors.js
// Meet renders Material icon names in <i> text nodes. Unlike aria-label values,
// those internal names are not localized (validated against Meet directly).
export function findByIconText(name, { visible = false } = {}) {
  const icons = document.querySelectorAll("i");
  for (const icon of icons) {
    if (icon.textContent.trim() !== name) continue;
    if (visible && !isVisible(icon)) continue;
    return icon;
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

export function isVisible(element) {
  const control = element.closest('button, [role="button"]');
  let checkAriaHidden = !control;
  for (let node = element; node; node = node.parentElement) {
    // Meet hides the decorative icon AND its wrapper from assistive technology.
    // Only aria-hidden on the control or its ancestors hides the meeting signal.
    if (node === control) checkAriaHidden = true;
    if (node.hidden || node.hasAttribute("inert") ||
        (checkAriaHidden && node.getAttribute("aria-hidden") === "true")) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}
