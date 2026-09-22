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
let t = (key) => key;

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

function sourceRow(iconName, label, active, activeLabel, inactiveLabel) {
  const color = active ? "var(--accent-green)" : "var(--text-muted)";
  return `<div class="source-row">
    <div class="source-label">${icon(iconName, { size: 16, color: "var(--text-secondary)" })}<span>${label}</span></div>
    <div class="source-status" style="color:${color}">
      <span class="dot small" style="background:${color}"></span>${active ? activeLabel : inactiveLabel}
    </div>
  </div>`;
}

function recordingControls() {
  const videoActive = Boolean(currentMeta.videoEnabled);
  return `<button class="icon-button video-button ${videoActive ? "is-active" : ""}" type="button" aria-label="${t("banner.enableVideoAria")}" data-asterion-enable-video>
      ${icon("video", { size: 17 })}
    </button>
    <button class="danger-button" id="stop-capture" type="button">${t("banner.stopButton")}</button>
    <button class="icon-button" id="toggle-expanded" type="button" aria-label="${isExpanded ? t("banner.collapseAria") : t("banner.expandAria")}">
      ${icon(isExpanded ? "chevron-up" : "chevron-down", { size: 17 })}
    </button>`;
}

function renderDetected() {
  return `<div class="banner pill detected">
    <img class="brand-icon" src="${chrome.runtime.getURL("icons/icon32.png")}" alt="" width="20" height="20">
    <div class="brand-copy"><strong>Ariadne</strong><span>${t("popup.statusDetected")}</span></div>
    <button class="primary-button" id="start-capture" type="button">${icon("play", { size: 15 })}${t("popup.startCapture")}</button>
  </div>`;
}

function renderRecording() {
  const sources = isExpanded
    ? `<div class="divider"></div>
      <div class="sources">
        ${sourceRow("file-text", t("common.transcript"), Boolean(currentMeta.hasTranscript), t("popup.activeFem"), t("common.notAvailable"))}
        ${sourceRow("volume-2", t("common.meetingAudioLabel"), true, t("popup.activeMasc"), "")}
        ${sourceRow("mic", t("popup.micLabel"), !currentMeta.micMuted, t("popup.activeFem"), t("popup.micMutedLabel"))}
        ${sourceRow("app-window", t("popup.tabVideoLabel"), Boolean(currentMeta.videoEnabled), t("popup.activeMasc"), t("popup.notActive"))}
      </div>
      <div class="info-row">${icon("info", { size: 16, color: "var(--text-secondary)" })}<span>${t("banner.recordingInfo")}</span></div>`
    : "";

  return `<div class="banner ${isExpanded ? "expanded" : "pill"}">
    <div class="recording-top">
      <div class="recording-copy"><img class="brand-icon" src="${chrome.runtime.getURL("icons/icon32.png")}" alt="" width="20" height="20"><strong>Ariadne</strong><span class="timer">${formatElapsed(currentMeta.startedAt)}</span></div>
      <div class="controls">${recordingControls()}</div>
    </div>
    ${sources}
  </div>`;
}

function renderError() {
  return `<div class="banner pill">
    <div class="recording-copy"><span class="dot" style="background:var(--accent-red)"></span><div class="brand-copy"><strong>${t("popup.statusError")}</strong><span>${t("banner.errorCopy")}</span></div></div>
  </div>`;
}

function renderFinished() {
  return `<div class="banner finished">
    <div class="finish-badge"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg></div>
    <div class="brand-copy finish-copy"><strong>${t("banner.finishedTitle")}</strong><span>${t("banner.finishedCopy")}</span></div>
    <button class="secondary-button" id="view-recording" type="button">${t("banner.viewRecording")} ${icon("arrow-up-right", { size: 15 })}</button>
    <button class="icon-button" id="dismiss-banner" type="button" aria-label="${t("banner.dismissAria")}">${icon("x", { size: 17 })}</button>
  </div>`;
}

function wireEvents() {
  contentEl.querySelector("#start-capture")?.addEventListener("click", callbacks.onStart);
  contentEl.querySelector("#stop-capture")?.addEventListener("click", callbacks.onStop);
  contentEl.querySelector("#toggle-expanded")?.addEventListener("click", () => {
    isExpanded = !isExpanded;
    render();
  });
  contentEl.querySelector("#view-recording")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/history/history.html") });
  });
  contentEl.querySelector("#dismiss-banner")?.addEventListener("click", () => {
    contentEl.innerHTML = "";
    clearInterval(timerInterval);
    timerInterval = null;
  });
}

function render() {
  if (!contentEl) return;
  clearInterval(timerInterval);
  timerInterval = null;

  if (currentState === "finished") {
    contentEl.innerHTML = renderFinished();
  } else if (currentState === "error") {
    contentEl.innerHTML = renderError();
  } else if (currentState === "recording" || currentState === "video-enabled") {
    contentEl.innerHTML = renderRecording();
    timerInterval = setInterval(() => {
      const timerEl = contentEl?.querySelector(".timer");
      if (timerEl) timerEl.textContent = formatElapsed(currentMeta.startedAt);
    }, 1000);
  } else {
    contentEl.innerHTML = renderDetected();
  }

  wireEvents();
  if (currentMeta.videoError) console.warn(t("banner.videoErrorLog"), currentMeta.videoError);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function applyBannerPosition(position, shouldClamp = false) {
  const { edge, offset } = position || {};
  if (!contentEl || !["top", "right", "bottom", "left"].includes(edge) || !Number.isFinite(offset)) return;

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
    contentEl.style.cursor = "";
  };

  contentEl.addEventListener("pointerup", finishDrag);
  contentEl.addEventListener("pointercancel", finishDrag);
}

export async function showBanner({ onStart, onStop }) {
  callbacks = { onStart, onStop };
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
      #content { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font-family: Inter, system-ui, sans-serif; touch-action: none; }
      .banner { width: 320px; box-sizing: border-box; background: var(--bg); border: 1px solid var(--border); box-shadow: 0 12px 32px var(--shadow); color: var(--text-primary); padding: 12px; }
      .pill { border-radius: 999px; }
      .expanded, .finished { border-radius: 20px; }
      .detected, .recording-top, .recording-copy, .controls, .brand-copy, .source-label, .source-status, .info-row, .finish-badge, .secondary-button, .primary-button, .danger-button, .icon-button { display: flex; align-items: center; }
      .detected, .recording-top { justify-content: space-between; gap: 12px; }
      .brand-icon { flex: 0 0 auto; border-radius: 6px; }
      .brand-copy { min-width: 0; flex-direction: column; align-items: flex-start; gap: 2px; }
      strong { color: var(--text-primary); font-size: 13px; font-weight: 650; }
      .brand-copy span, .timer { color: var(--text-secondary); font-size: 12px; }
      .recording-copy { gap: 8px; min-width: 0; }
      .controls { gap: 6px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
      .dot.small { width: 6px; height: 6px; }
      button { font: inherit; cursor: pointer; }
      .primary-button, .danger-button, .secondary-button { border: 0; border-radius: 999px; color: #fff; gap: 6px; font-size: 12px; font-weight: 600; padding: 8px 11px; white-space: nowrap; }
      .primary-button { background: var(--accent-blue); }
      .danger-button { background: var(--accent-red); }
      .secondary-button { background: var(--bg-button); color: var(--text-primary); }
      .icon-button { justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: var(--bg-button); color: var(--text-secondary); }
      .video-button.is-active { background: var(--accent-green); color: #fff; }
      .divider { border-top: 1px solid var(--border); margin: 12px 0; }
      .sources { display: flex; flex-direction: column; gap: 10px; }
      .source-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
      .source-label { gap: 8px; color: var(--text-primary); font-size: 12px; }
      .source-status { gap: 5px; font-size: 11px; white-space: nowrap; }
      .info-row { gap: 8px; margin-top: 12px; color: var(--text-secondary); font-size: 11px; line-height: 1.35; align-items: flex-start; }
      .info-row svg { flex: 0 0 auto; margin-top: 1px; }
      .info-row span { min-width: 0; }
      .finished { display: flex; align-items: center; gap: 10px; min-width: 430px; }
      .finish-badge { justify-content: center; width: 30px; height: 30px; flex: 0 0 auto; border-radius: 50%; background: var(--accent-green); color: #fff; }
      .finish-copy { flex: 1; }
      .finished .icon-button { margin-left: -2px; }
    </style><div id="content"></div>`;
  contentEl = shadowRoot.getElementById("content");
  wireDragEvents();

  chrome.storage.local.get({ [BANNER_POSITION_KEY]: null }, ({ [BANNER_POSITION_KEY]: bannerPosition }) => {
    applyBannerPosition(bannerPosition);
    document.body.appendChild(hostEl);
    applyBannerPosition(bannerPosition, true);
    render();
  });
}

export function updateBannerState(state, meta = {}) {
  currentState = state;
  currentMeta = { ...currentMeta, ...meta };
  if (state !== "recording" && state !== "video-enabled") isExpanded = false;
  render();
}

export function showFinishedBanner() {
  currentState = "finished";
  isExpanded = false;
  render();
}
