// Teams does not publish a DOM API. Keep its interface anchors together so
// changes can be checked against a real call without touching capture/storage.
export const TEAMS_SELECTORS = {
  hangup: '#hangup-button, #hangup-btn, [data-tid="hangup-leave-btn"], [data-tid="call-hangup"]',
  microphone: '#microphone-button, #mic-button, [data-tid="microphone-button"], [data-tid="mic-button"]',
  captionsToggle: '#closed-captions-button, #captions-button, [data-tid="closed-captions-button"], [data-tid="captions-button"]',
  captionsContainer: '[data-tid="closed-caption-v2-virtual-list-content"], [data-tid="closed-captions-renderer"], [data-tid="closed-captions-container"]',
  captionUtteranceBlock: '[data-tid="closed-caption-chat-message"], .fui-ChatMessageCompact',
  captionSpeakerName: '[data-tid="author"], [data-tid="closed-caption-speaker-name"], .fui-ChatMessage__author, .fui-ChatMessageCompact__author, .ui-chat__message__author',
  captionText: '[data-tid="closed-caption-text"]',
  more: '#callingButtons-showMoreBtn, #more-button, [data-tid="more-button"], [data-tid="calling-more-menu"]',
  title: '[data-tid="meeting-title"], [data-tid="call-title"], h2[data-tid="chat-title"]',
};

export function isVisible(element) {
  if (!element || element.closest('[hidden], [aria-hidden="true"]')) return false;
  for (let current = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function findVisible(selector, root = document) {
  return [...root.querySelectorAll(selector)].find(isVisible) ?? null;
}

export function isInTeamsMeeting() {
  return Boolean(findVisible(TEAMS_SELECTORS.hangup));
}

export function getTeamsMeetingTitle() {
  return findVisible(TEAMS_SELECTORS.title)?.textContent.trim() || document.title.trim() || "Microsoft Teams";
}
