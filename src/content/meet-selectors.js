// src/content/meet-selectors.js
// Best-effort selectors — Meet does not expose a stable API for this. Confirm against
// the live DOM during manual verification and adjust here when Meet changes its UI.
export const SELECTORS = {
  hangUpButton: '[aria-label="Leave call"]',
  micButton: '[aria-label*="microphone" i]',
  micMutedAttribute: "data-is-muted",
  captionsToggleButton: 'button[jsname="RrG0hf"], button[jslog^="211197"]',
  // NOT yet confirmed in a live Meet DOM with captions on. Fireflies 6.6.0 finds
  // this region, but reads captions_v2 frames rather than DOM children; these
  // generated-class child selectors are best-effort fallbacks to re-check live.
  captionsContainer: 'div[jsname="xySENc"][aria-live="polite"]',
  captionSpeakerName: ".NWpY1d",
  captionText: ".ygicle.VbkSUe",
};
