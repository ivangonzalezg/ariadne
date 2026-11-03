// Modal isolation (aria-hidden/inert) affects interaction, not meeting presence.
export function isRendered(element) {
  if (!element?.isConnected) return false;
  for (let node = element; node; node = node.parentElement) {
    if (node.hidden) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}
