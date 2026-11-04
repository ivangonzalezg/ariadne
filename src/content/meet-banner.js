import { captionStatusLabel } from "../shared/caption-status.js";
// src/content/meet-banner.js
import { icon } from "../shared/icons.js";
import { initI18n } from "../shared/i18n/i18n.js";

let hostEl = null;
let contentEl = null;
let callbacks = null;
let currentState = "idle";
let currentMeta = {};
let isExpanded = false;
let timerInterval = null;
let bannerReady = false;
let bannerPosition = { edge: "bottom", offset: null };
let isDragging = false;
let t = (key) => key;
let motionView = null;
let motionFrame = null;
let pendingMotion = null;
let motionVersion = 0;
const motionAnimations = new Map();
const motionSnapshots = new Set();

const EDGE_MARGIN = 16;
const BANNER_POSITION_KEY = "bannerPosition";

function formatElapsed(startedAt) {
  if (!startedAt) return "00:00";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function sourceRow(name, iconName, label) {
  return `<div class="source-row" data-source="${name}">
    <div class="source-label">${icon(iconName, { size: 16, color: "var(--text-secondary)" })}<span>${label}</span></div>
    <div class="source-status"><span class="dot small"></span><span class="status-label"></span></div>
  </div>`;
}

function renderMeeting() {
  return `<div class="banner meeting" tabindex="-1" data-recording="false" data-expanded="false">
    <div class="recording-top">
      <div class="identity">
        <img class="brand-icon" src="${chrome.runtime.getURL("icons/icon32.png")}" alt="" width="20" height="20">
        <div class="brand-copy"><strong>Ariadne</strong><span class="detected-label">${t("popup.statusDetected")}</span></div>
        <span class="timer" aria-hidden="true">00:00</span>
      </div>
      <div class="actions">
        <div class="start-controls"><button class="primary-button" id="start-capture" type="button">${icon("play", { size: 15 })}<span class="start-label">${t("popup.startCapture")}</span></button></div>
        <div class="controls" inert aria-hidden="true">
          <button class="icon-button video-button" type="button" aria-label="${t("banner.enableVideoAria")}" data-asterion-enable-video>${icon("video", { size: 17 })}</button>
          <button class="danger-button" id="stop-capture" type="button">${t("banner.stopButton")}</button>
          <button class="icon-button" id="toggle-expanded" type="button" aria-expanded="false" aria-controls="capture-details" aria-label="${t("banner.expandAria")}">${icon("chevron-down", { size: 17 })}</button>
        </div>
      </div>
    </div>
    <p class="info-row backup-busy" role="status" hidden></p>
    <div class="details" id="capture-details" inert aria-hidden="true"><div class="details-inner">
      <div class="divider"></div>
      <div class="sources">
        ${sourceRow("transcript", "file-text", t("common.transcript"))}
        ${sourceRow("audio", "volume-2", t("common.audio"))}
        ${sourceRow("video", "video", t("common.video"))}
      </div>
      <div class="info-row">${icon("info", { size: 16, color: "var(--text-secondary)" })}<span>${t("banner.recordingInfo")}</span></div>
    </div></div>
  </div>`;
}

function renderError() {
  return `<div class="banner pill error-banner" tabindex="-1">
    <div class="recording-copy"><span class="dot" style="background:var(--accent-red)"></span><div class="brand-copy"><strong>${t("popup.statusError")}</strong><span>${t("banner.errorCopy")}</span></div></div>
  </div>`;
}

function renderFinished() {
  return `<div class="banner finished">
    <div class="finish-badge"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg></div>
    <div class="brand-copy finish-copy" role="status" aria-live="polite" aria-atomic="true"><strong>${t("banner.finishedTitle")}</strong><span>${t("banner.finishedCopy")}</span></div>
    <button class="secondary-button" id="view-recording" type="button">${t("banner.viewRecording")} ${icon("arrow-up-right", { size: 15 })}</button>
    <button class="icon-button" id="dismiss-banner" type="button" aria-label="${t("banner.dismissAria")}">${icon("x", { size: 17 })}</button>
    <span class="open-error" role="alert" hidden>${t("banner.openHistoryError")}</span>
  </div>`;
}

function setAccessible(element, visible) {
  element.toggleAttribute("inert", !visible);
  element.setAttribute("aria-hidden", String(!visible));
}

function updateSource(name, active, label) {
  const status = contentEl.querySelector(`[data-source="${name}"] .source-status`);
  status.classList.toggle("is-active", active);
  status.querySelector(".status-label").textContent = label;
}

function wireEvents() {
  // Delegate once so metadata updates never duplicate listeners or lose focus.
  contentEl.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || button.closest("[inert], [hidden]")) return;
    switch (button.id) {
      case "start-capture":
        currentState = "starting";
        render();
        callbacks.onStart();
        break;
      case "stop-capture": callbacks.onStop(); break;
      case "toggle-expanded": isExpanded = !isExpanded; render(); break;
      case "view-recording": void openRecording(button); break;
      case "dismiss-banner": dismissBanner(currentMeta.captureSessionId); break;
    }
  });
}

function dismissBanner(sessionId) {
  if (sessionId !== currentMeta.captureSessionId) return;
  if (callbacks.onDismiss) callbacks.onDismiss(sessionId);
  else { currentMeta.visible = false; render(); }
}

async function openRecording(button) {
  const sessionId = currentMeta.captureSessionId;
  button.disabled = true;
  contentEl.querySelector(".open-error").hidden = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "asterion:open-history", sessionId: sessionId ?? null });
    if (!result?.ok) throw new Error(result?.error ?? "Could not open history");
    dismissBanner(sessionId);
  } catch {
    if (sessionId === currentMeta.captureSessionId) contentEl.querySelector(".open-error").hidden = false;
  } finally { button.disabled = false; }
}

function motionTokens() {
  const style = getComputedStyle(contentEl);
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const duration = name => parseFloat(style.getPropertyValue(name));
  return { reduced, enter: duration(reduced ? "--motion-reduced" : "--motion-enter"),
    exit: duration(reduced ? "--motion-reduced" : "--motion-exit"),
    swap: duration(reduced ? "--motion-reduced" : "--motion-swap"),
    distance: reduced ? 0 : parseFloat(style.getPropertyValue("--motion-distance")),
    easing: style.getPropertyValue("--ease-out").trim() };
}

function cancelMotion(element) {
  const animation = motionAnimations.get(element);
  if (!animation) return;
  const style = getComputedStyle(element);
  element.style.opacity = style.opacity;
  element.style.transform = style.transform;
  motionAnimations.delete(element);
  animation.cancel();
}

function animateMotion(element, frames, duration, onFinish = () => {}) {
  cancelMotion(element);
  if (motionTokens().reduced) frames = frames.map(({ transform, ...frame }) => frame);
  const animation = element.animate(frames, { duration, easing: motionTokens().easing, fill: "both" });
  motionAnimations.set(element, animation);
  animation.finished.then(() => {
    if (motionAnimations.get(element) !== animation) return;
    motionAnimations.delete(element);
    animation.cancel();
    element.style.opacity = "";
    element.style.transform = "";
    onFinish();
  }, () => {}); // Cancellation is expected when a newer state or a drag interrupts.
}

function snapshotMotion(source, append = true) {
  const rect = source.getBoundingClientRect();
  const copy = source.cloneNode(true);
  const originalNodes = [source, ...source.querySelectorAll("*")];
  const copiedNodes = [copy, ...copy.querySelectorAll("*")];
  copiedNodes.forEach((node, index) => {
    const style = getComputedStyle(originalNodes[index]);
    node.style.opacity = style.opacity;
    node.style.transform = style.transform;
    node.style.color = style.color;
    node.style.backgroundColor = style.backgroundColor;
    node.removeAttribute("id");
    node.removeAttribute("role");
    node.removeAttribute("aria-live");
    node.removeAttribute("data-asterion-enable-video");
    if (node.matches("button")) { node.disabled = true; node.tabIndex = -1; }
  });
  // A status fragment inherits a partially entered panel's opacity.
  for (let parent = source.parentElement; parent && parent !== contentEl; parent = parent.parentElement) {
    copy.style.opacity = String(Number(copy.style.opacity) * Number(getComputedStyle(parent).opacity));
  }
  // The rect already includes the source's current transform; do not apply it twice.
  copy.style.transform = "none";
  copy.classList.add("motion-snapshot");
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("inert", "");
  Object.assign(copy.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", maxWidth: "none", maxHeight: "none" });
  if (append) {
    contentEl.append(copy);
    motionSnapshots.add(copy);
  }
  return copy;
}

function removeMotionSnapshot(copy) {
  motionSnapshots.delete(copy);
  copy.remove();
}

function prepareMotion(view) {
  const previous = motionView;
  motionView = view;
  if (document.visibilityState === "hidden") { finishMotion(); return null; }
  if (!contentEl.isConnected || typeof contentEl.animate !== "function") return null;
  if (previous?.visible === view.visible && previous?.key === view.key) return null;
  if (!pendingMotion) {
    const surface = contentEl.querySelector(".banner-surface");
    const fragments = previous?.visible && !contentEl.hidden
      ? previous.pane === view.pane && view.visible
        ? [...previous.pane.querySelectorAll(".finish-copy, .finish-badge")]
        : [previous.pane]
      : [];
    pendingMotion = { fromRect: contentEl.hidden ? null : surface.getBoundingClientRect(),
      copies: fragments.map(source => snapshotMotion(source)),
      fullCopy: previous?.visible && previous.pane === view.pane && view.visible ? snapshotMotion(previous.pane, false) : null,
      previous, view, version: ++motionVersion };
  } else {
    if (pendingMotion.fullCopy && (view.pane !== pendingMotion.previous.pane || !view.visible)) {
      for (const copy of pendingMotion.copies) removeMotionSnapshot(copy);
      pendingMotion.copies = [pendingMotion.fullCopy];
      contentEl.append(pendingMotion.fullCopy);
      motionSnapshots.add(pendingMotion.fullCopy);
      pendingMotion.fullCopy = null;
    }
    pendingMotion.view = view;
  }
  return pendingMotion;
}

function scheduleMotion(request) {
  if (!request) return;
  const { view, previous } = request;
  const statusSwap = view.visible && previous?.visible && view.pane === previous.pane;
  const targets = view.visible ? statusSwap
    ? [...view.pane.querySelectorAll(".finish-copy, .finish-badge")] : [view.pane] : [];
  for (const target of request.targets ?? []) {
    if (!targets.includes(target)) { target.style.opacity = ""; target.style.transform = ""; }
  }
  request.targets = targets;
  const { distance } = motionTokens();
  for (const target of targets) {
    cancelMotion(target);
    target.style.opacity = "0";
    target.style.transform = `translateY(${distance}px)`;
  }
  if (motionFrame !== null) return;
  motionFrame = requestAnimationFrame(() => {
    motionFrame = null;
    const motion = pendingMotion;
    pendingMotion = null;
    const tokens = motionTokens();
    const surface = contentEl.querySelector(".banner-surface");
    const { view, previous, version } = motion;
    for (const copy of motion.copies) {
      const opacity = getComputedStyle(copy).opacity;
      animateMotion(copy, [{ opacity, transform: copy.style.transform },
        { opacity: 0, transform: `translateY(${view.visible ? -tokens.distance : tokens.distance}px)` }],
      view.visible && view.pane === previous?.pane ? tokens.swap : tokens.exit, () => removeMotionSnapshot(copy));
    }
    if (!view.visible) {
      const bounds = contentEl.getBoundingClientRect();
      contentEl.style.width = `${bounds.width}px`;
      contentEl.style.height = `${bounds.height}px`;
      for (const pane of contentEl.querySelectorAll(":scope > .banner:not(.motion-snapshot)")) pane.hidden = true;
      const style = getComputedStyle(surface);
      animateMotion(surface, [{ opacity: style.opacity, transform: style.transform },
        { opacity: 0, transform: `translateY(${tokens.distance}px)` }], tokens.exit, () => {
        if (motionVersion === version && !motionView.visible) {
          contentEl.hidden = true;
          contentEl.style.width = "";
          contentEl.style.height = "";
        }
      });
      return;
    }
    const statusSwap = previous?.visible && previous.pane === view.pane;
    for (const target of motion.targets) {
      animateMotion(target, [{ opacity: 0, transform: `translateY(${tokens.distance}px)` },
        { opacity: 1, transform: "translateY(0)" }], statusSwap ? tokens.swap : tokens.enter);
    }
    if (!isDragging && Number.isFinite(bannerPosition.offset)) applyBannerPosition(bannerPosition, true);
    const toRect = contentEl.getBoundingClientRect();
    const from = motion.fromRect;
    const style = getComputedStyle(surface);
    const transform = !tokens.reduced && from?.width && from?.height && toRect.width && toRect.height
      ? `translate(${from.left - toRect.left}px, ${from.top - toRect.top}px) scale(${from.width / toRect.width}, ${from.height / toRect.height})`
      : `translateY(${!from ? tokens.distance : 0}px)`;
    const resized = !from || Math.abs(from.left - toRect.left) > 0.5 || Math.abs(from.top - toRect.top) > 0.5 ||
      Math.abs(from.width - toRect.width) > 0.5 || Math.abs(from.height - toRect.height) > 0.5;
    if (resized || !previous?.visible || Number(style.opacity) < 1) {
      animateMotion(surface, [{ opacity: from ? style.opacity : 0, transform },
        { opacity: 1, transform: "translateY(0)" }], tokens.enter);
    }
  });
}

function finishMotion() {
  if (!motionView) return;
  if (motionFrame !== null) cancelAnimationFrame(motionFrame);
  motionFrame = null;
  pendingMotion = null;
  motionVersion++;
  for (const [element, animation] of motionAnimations) {
    animation.cancel();
    element.style.opacity = "";
    element.style.transform = "";
  }
  motionAnimations.clear();
  for (const copy of motionSnapshots) copy.remove();
  motionSnapshots.clear();
  for (const pane of contentEl.querySelectorAll(":scope > .banner:not(.motion-snapshot)")) {
    pane.style.opacity = "";
    pane.style.transform = "";
    pane.hidden = !motionView.visible || pane !== motionView.pane;
  }
  for (const fragment of contentEl.querySelectorAll(".finish-copy, .finish-badge")) {
    fragment.style.opacity = "";
    fragment.style.transform = "";
  }
  contentEl.hidden = !motionView.visible;
  contentEl.style.width = "";
  contentEl.style.height = "";
}

function render() {
  if (!contentEl) return;
  const meeting = contentEl.querySelector(":scope > .meeting");
  const finished = contentEl.querySelector(":scope > .finished");
  const error = contentEl.querySelector(":scope > .error-banner");
  const noticeState = ["saving", "processing", "finished", "capture-error"].includes(currentState);
  const pane = noticeState ? finished : currentState === "error" ? error : meeting;
  const visible = currentMeta.visible !== false;
  const request = prepareMotion({ pane, visible, key: noticeState ? currentState : pane.className });
  setAccessible(contentEl, visible);
  if (!visible) {
    clearInterval(timerInterval);
    timerInterval = null;
    if (request) scheduleMotion(request);
    else if (!pendingMotion && !motionAnimations.size) contentEl.hidden = true;
    return;
  }
  contentEl.hidden = false;
  contentEl.style.width = "";
  contentEl.style.height = "";
  const recording = currentState === "recording" || currentState === "video-enabled";
  const specialState = noticeState || currentState === "error";
  const activeElement = contentEl.getRootNode().activeElement;
  meeting.hidden = specialState;
  const backupNotice = meeting.querySelector(".backup-busy");
  backupNotice.hidden = !currentMeta.backupBusy;
  backupNotice.textContent = currentMeta.backupBusy ? t("backup.busy") : "";
  error.hidden = currentState !== "error";
  for (const panel of [meeting, finished, error]) setAccessible(panel, panel === pane);
  finished.hidden = !noticeState;
  const noticeChanged = finished.dataset.status !== currentState;
  finished.dataset.status = currentState;
  const noticeKey = { saving: "saving", processing: "processing", finished: "finished", "capture-error": "captureError" }[currentState];
  contentEl.dataset.panel = noticeState ? "finished" : currentState === "error" ? "error" : "meeting";
  contentEl.dataset.expanded = String(recording && isExpanded);
  if (noticeKey && noticeChanged) {
    finished.querySelector(".finish-copy strong").textContent = t(`banner.${noticeKey}Title`);
    finished.querySelector(".finish-copy span").textContent = t(`banner.${noticeKey}Copy`);
    finished.querySelector(".finish-badge").innerHTML = icon(currentState === "finished" ? "check" : currentState === "capture-error" ? "info" : "file-text", { size: 17 });
  }

  const start = contentEl.querySelector("#start-capture");
  start.disabled = currentState !== "idle";
  start.setAttribute("aria-busy", String(currentState === "starting"));
  setAccessible(contentEl.querySelector(".start-controls"), !recording && !specialState);
  setAccessible(contentEl.querySelector(".controls"), recording);
  setAccessible(contentEl.querySelector(".detected-label"), !recording);
  const timer = contentEl.querySelector(".timer");
  timer.setAttribute("aria-hidden", String(!recording));
  timer.textContent = formatElapsed(currentMeta.startedAt);
  meeting.dataset.recording = String(recording);
  meeting.dataset.expanded = String(recording && isExpanded);
  const toggle = contentEl.querySelector("#toggle-expanded");
  toggle.setAttribute("aria-expanded", String(recording && isExpanded));
  toggle.setAttribute("aria-label", t(isExpanded ? "banner.collapseAria" : "banner.expandAria"));
  setAccessible(contentEl.querySelector(".details"), recording && isExpanded);
  contentEl.querySelector(".video-button").classList.toggle("is-active", Boolean(currentMeta.videoEnabled));
  contentEl.querySelector(".video-button").setAttribute("aria-pressed", String(Boolean(currentMeta.videoEnabled)));
  updateSource("transcript", Boolean(currentMeta.transcriptActive) && !currentMeta.captionStorage?.error, captionStatusLabel(currentMeta, t));
  updateSource("audio", true, t("popup.activeMasc"));
  updateSource("video", Boolean(currentMeta.videoEnabled), t(currentMeta.videoEnabled ? "popup.activeMasc" : "popup.notActive"));

  if (recording && timerInterval === null) {
    timerInterval = setInterval(() => { timer.textContent = formatElapsed(currentMeta.startedAt); }, 1000);
  } else if (!recording) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  // Transfer focus only when the previously focused control becomes unavailable.
  const focusUnavailable = activeElement && contentEl.contains(activeElement) && (
    activeElement.closest("[inert], [hidden]") ||
    (activeElement === start && start.disabled) ||
    (activeElement === meeting && recording)
  );
  if (focusUnavailable) {
    let destination = start;
    if (noticeState) destination = contentEl.querySelector("#view-recording");
    else if (currentState === "error") destination = contentEl.querySelector(".error-banner");
    else if (recording) destination = contentEl.querySelector("#stop-capture");
    else if (start.disabled) destination = meeting;
    destination.focus({ preventScroll: true });
  }
  scheduleMotion(request);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function applyBannerPosition(position, shouldClamp = false) {
  const { edge, offset } = position || {};
  if (!contentEl || !["top", "right", "bottom", "left"].includes(edge) || !Number.isFinite(offset)) return;

  bannerPosition = { edge, offset };
  contentEl.style.left = "auto";
  contentEl.style.right = "auto";
  contentEl.style.top = "auto";
  contentEl.style.bottom = "auto";
  contentEl.style[edge] = `${EDGE_MARGIN}px`;

  if (edge === "left" || edge === "right") {
    contentEl.style.top = `${offset}px`;
    if (shouldClamp) {
      const rect = contentEl.getBoundingClientRect();
      contentEl.style.top = `${clamp(rect.top, EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN)}px`;
    }
  } else {
    contentEl.style.left = `${offset}px`;
    if (shouldClamp) {
      const rect = contentEl.getBoundingClientRect();
      contentEl.style.left = `${clamp(rect.left, EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN)}px`;
    }
  }
}

function saveBannerPosition(position) {
  chrome.storage.local.set({ [BANNER_POSITION_KEY]: position });
}

function snapToNearestEdge() {
  const rect = contentEl.getBoundingClientRect();
  const distances = {
    top: rect.top,
    bottom: window.innerHeight - rect.bottom,
    left: rect.left,
    right: window.innerWidth - rect.right,
  };
  const edge = Object.entries(distances).sort(([, first], [, second]) => first - second)[0][0];
  const isVerticalEdge = edge === "left" || edge === "right";
  const offset = isVerticalEdge
    ? clamp(rect.top, EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN)
    : clamp(rect.left, EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN);

  applyBannerPosition({ edge, offset });
  saveBannerPosition({ edge, offset });
}

function wireDragEvents() {
  let dragState = null;

  contentEl.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) return;

    finishMotion();
    const rect = contentEl.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
    };
    contentEl.setPointerCapture(event.pointerId);
  });

  contentEl.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < 5) return;

    dragState.moved = true;
    isDragging = true;
    contentEl.style.cursor = "grabbing";
    contentEl.style.left = `${dragState.originLeft + dx}px`;
    contentEl.style.top = `${dragState.originTop + dy}px`;
    contentEl.style.right = "auto";
    contentEl.style.bottom = "auto";
  });

  const finishDrag = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    if (dragState.moved) snapToNearestEdge();
    if (contentEl.hasPointerCapture(event.pointerId)) contentEl.releasePointerCapture(event.pointerId);
    dragState = null;
    isDragging = false;
    contentEl.style.cursor = "";
  };

  contentEl.addEventListener("pointerup", finishDrag);
  contentEl.addEventListener("pointercancel", finishDrag);
}

export async function showBanner({ onStart, onStop, onDismiss }) {
  callbacks = { onStart, onStop, onDismiss };
  if (hostEl || bannerReady) return;
  bannerReady = true;

  try {
    ({ t } = await initI18n());
  } catch (error) {
    console.error("[Ariadne] i18n initialization failed for the Meet banner", error);
    bannerReady = false;
    return;
  }

  hostEl = document.createElement("div");
  hostEl.id = "asterion-banner-host";
  const shadowRoot = hostEl.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL("src/shared/theme.css")}">
    <style>
      #content { --ease-out: cubic-bezier(0.23, 1, 0.32, 1); --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1); --motion-enter: 250ms; --motion-exit: 150ms; --motion-swap: 150ms; --motion-reduced: 120ms; --motion-distance: 4px; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font-family: Inter, system-ui, sans-serif; touch-action: none; }
      .banner { width: 320px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); overflow-y: auto; scrollbar-width: thin; box-sizing: border-box; position: relative; background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 12px; }
      .banner-surface { position: absolute; inset: 0; box-sizing: border-box; background: var(--bg); border: 1px solid var(--border); box-shadow: 0 12px 32px var(--shadow); border-radius: 28px; pointer-events: none; transform-origin: 0 0; }
      #content[data-panel="finished"] .banner-surface { border-radius: 16px; }
      #content[data-panel="error"] .banner-surface { border-radius: 999px; }
      #content[data-panel="meeting"][data-expanded="true"] .banner-surface { border-radius: 20px; }
      .motion-snapshot, .motion-snapshot * { pointer-events: none !important; transition: none !important; animation: none !important; }
      .pill { border-radius: 999px; }
      .recording-top, .recording-copy, .controls, .brand-copy, .source-label, .source-status, .info-row, .finish-badge, .secondary-button, .primary-button, .danger-button, .icon-button { display: flex; align-items: center; }
      .recording-top { justify-content: space-between; gap: 8px; min-height: 32px; }
      .brand-icon { flex: 0 0 auto; border-radius: 6px; }
      .brand-copy { min-width: 0; flex-direction: column; align-items: flex-start; gap: 2px; }
      strong { color: var(--text-primary); font-size: 13px; font-weight: 650; }
      .brand-copy span, .timer { color: var(--text-secondary); font-size: 12px; }
      .recording-copy { gap: 8px; min-width: 0; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
      .dot.small { width: 6px; height: 6px; }
      button { font: inherit; cursor: pointer; }
      .primary-button, .danger-button, .secondary-button { border: 0; border-radius: 999px; color: #fff; gap: 6px; font-size: 12px; font-weight: 600; padding: 8px 11px; white-space: nowrap; }
      .primary-button { background: var(--accent-blue); }
      .danger-button { background: var(--accent-red); }
      .secondary-button { background: var(--bg-button); color: var(--text-primary); }
      .icon-button { flex: 0 0 32px; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: var(--bg-button); color: var(--text-secondary); }
      .video-button.is-active { background: var(--accent-green); color: #fff; }
      .divider { border-top: 1px solid var(--border); margin: 12px 0; }
      .sources { display: flex; flex-direction: column; gap: 10px; }
      .source-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
      .source-label { gap: 8px; color: var(--text-primary); font-size: 12px; }
      .source-status { gap: 5px; font-size: 11px; white-space: nowrap; color: var(--text-muted); }
      .info-row { gap: 8px; margin-top: 12px; color: var(--text-secondary); font-size: 11px; line-height: 1.35; align-items: flex-start; }
      .info-row svg { flex: 0 0 auto; margin-top: 1px; }
      .info-row span { min-width: 0; }
      .finished { border-radius: 16px; display: flex; align-items: center; gap: 10px; width: 430px; flex-wrap: wrap; }
      .finish-badge { justify-content: center; width: 30px; height: 30px; flex: 0 0 auto; border-radius: 50%; background: var(--accent-green); color: #fff; }
      .finish-copy { flex: 1 1 160px; }
      .finish-badge { transition: background-color var(--motion-swap) var(--ease-out), color var(--motion-swap) var(--ease-out); }
      .finished .icon-button { margin-left: -2px; }
      [hidden] { display: none !important; }
      .meeting {
        --state-duration: 180ms;
        --panel-duration: 300ms;
        border-radius: 28px;
        transition: border-radius var(--panel-duration) var(--ease-drawer);
      }
      .meeting[data-recording="true"] { --state-duration: 240ms; }
      .meeting[data-expanded="true"] { --panel-duration: 240ms; border-radius: 20px; }
      .identity { position: relative; display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
      .identity .brand-copy { display: block; height: 32px; flex: 1; position: relative; }
      .identity strong { display: block; line-height: 16px; transition: transform var(--state-duration) var(--ease-drawer); }
      .detected-label { position: absolute; left: 0; right: 0; bottom: 0; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity 120ms var(--ease-out); }
      .timer { position: absolute; right: 0; width: 58px; text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; white-space: nowrap; opacity: 0; transform: translateY(4px); transition: opacity var(--state-duration) var(--ease-out), transform var(--state-duration) var(--ease-out); }
      .meeting[data-recording="true"] .identity strong { transform: translateY(8px); }
      .meeting[data-recording="true"] .detected-label { opacity: 0; }
      .meeting[data-recording="true"] .timer { opacity: 1; transform: translateY(0); }
      .actions { display: grid; grid-template-columns: minmax(0, 1fr); width: 144px; flex: 0 0 144px; }
      .start-controls, .controls { grid-area: 1 / 1; justify-content: flex-end; display: flex; align-items: center; }
      .controls { gap: 4px; opacity: 0; pointer-events: none; transition: opacity 180ms var(--ease-out); }
      .start-controls { min-width: 0; opacity: 1; transition: opacity 120ms var(--ease-out); }
      .start-label { overflow: hidden; text-overflow: ellipsis; }
      .start-controls button { min-width: 0; max-width: 100%; }
      .start-controls svg { flex-shrink: 0; }
      .meeting[data-recording="true"] .start-controls { opacity: 0; pointer-events: none; transition-duration: 240ms; }
      .meeting[data-recording="true"] .controls { opacity: 1; pointer-events: auto; transition-duration: 400ms; }
      .controls .icon-button { opacity: 0; transform: translateY(4px); transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out), background-color 120ms var(--ease-out), color 120ms var(--ease-out); }
      .meeting[data-recording="true"] .controls .icon-button { opacity: 1; transform: translateY(0); transition-duration: 400ms, 400ms, 120ms, 120ms; transition-delay: 40ms, 40ms, 0ms, 0ms; }
      .meeting[data-recording="true"] #toggle-expanded { transition-delay: 80ms, 80ms, 0ms, 0ms; }
      #toggle-expanded svg { transition: transform var(--panel-duration) var(--ease-drawer); }
      .meeting[data-expanded="true"] #toggle-expanded svg { transform: rotate(180deg); }
      .details { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--panel-duration) var(--ease-drawer), opacity var(--panel-duration) var(--ease-out); }
      .details-inner { min-height: 0; overflow: hidden; }
      .meeting[data-expanded="true"] .details { grid-template-rows: 1fr; opacity: 1; }
      .source-status.is-active { color: var(--accent-green); }
      .source-status .dot { background: currentColor; }
      button { transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 120ms cubic-bezier(0.23, 1, 0.32, 1); }
      button:active:not(:disabled), .meeting[data-recording="true"] .controls .icon-button:active { transform: scale(0.97); transition-delay: 0ms; }
      .backup-busy { margin: 0 12px 8px; }
      .backup-busy[hidden] { display: none; }
      button:focus-visible, .error-banner:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: 0.7; }
      @media (hover: hover) and (pointer: fine) {
        button:hover:not(:disabled) { filter: brightness(1.1); }
      }
      @media (max-width: 359px) {
        .identity .brand-icon { display: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .meeting, .identity strong, #toggle-expanded svg { transition: none; }
        .details { transition: opacity 120ms var(--ease-out); }
        .meeting[data-expanded="true"] .details { transition-duration: 120ms; }
        .timer, .controls .icon-button, button { transform: none !important; transition: opacity 120ms var(--ease-out), background-color 120ms var(--ease-out); transition-delay: 0ms !important; }
        .controls, .meeting[data-recording="true"] .controls, .meeting[data-recording="true"] .controls .icon-button, .meeting[data-recording="true"] .start-controls { transition-duration: 120ms; }
      }
      .finished[data-status="saving"] .finish-badge, .finished[data-status="processing"] .finish-badge { color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 14%, transparent); }
      .finished[data-status="capture-error"] .finish-badge { color: var(--accent-red); background: color-mix(in srgb, var(--accent-red) 14%, transparent); }
      .finish-copy strong { font-size: 14px; line-height: 20px; text-wrap: balance; }
      .finish-copy span, .open-error { font-size: 12px; line-height: 16px; text-wrap: pretty; }
      .open-error { color: var(--accent-red); flex-basis: 100%; }
    </style><div id="content" hidden><div class="banner-surface" aria-hidden="true"></div>${renderMeeting()}${renderError()}${renderFinished()}</div>`;
  contentEl = shadowRoot.getElementById("content");
  wireDragEvents();
  wireEvents();
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (!isDragging && Number.isFinite(bannerPosition.offset)) applyBannerPosition(bannerPosition, true);
    }).observe(contentEl);
  }
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", finishMotion);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") finishMotion();
  });
  window.addEventListener("resize", () => {
    finishMotion();
    if (!isDragging && Number.isFinite(bannerPosition.offset)) applyBannerPosition(bannerPosition, true);
  });

  chrome.storage.local.get({ [BANNER_POSITION_KEY]: null }, ({ [BANNER_POSITION_KEY]: bannerPosition }) => {
    applyBannerPosition(bannerPosition);
    document.body.appendChild(hostEl);
    render();
    applyBannerPosition(bannerPosition, true);
  });
}

export function updateBannerState(state, meta = {}) {
  currentState = state;
  currentMeta = { ...currentMeta, ...meta };
  if (meta.videoError) console.warn("[Ariadne] Could not enable video:", meta.videoError);
  if (state !== "recording" && state !== "video-enabled") isExpanded = false;
  render();
}

export function showFinishedBanner() {
  currentState = "finished";
  isExpanded = false;
  render();
}
