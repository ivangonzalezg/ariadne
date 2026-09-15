// src/content/meet-banner.js
import { icon } from "../shared/icons.js";

let hostEl = null;
let contentEl = null;
let callbacks = null;
let currentState = "idle";
let currentMeta = {};
let isExpanded = false;
let timerInterval = null;

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
  return `<button class="icon-button video-button ${videoActive ? "is-active" : ""}" type="button" aria-label="Activar video" data-asterion-enable-video>
      ${icon("video", { size: 17 })}
    </button>
    <button class="danger-button" id="stop-capture" type="button">Detener</button>
    <button class="icon-button" id="toggle-expanded" type="button" aria-label="${isExpanded ? "Contraer" : "Expandir"}">
      ${icon(isExpanded ? "chevron-up" : "chevron-down", { size: 17 })}
    </button>`;
}

function renderDetected() {
  return `<div class="banner pill detected">
    <div class="brand-copy"><strong>Asterion</strong><span>Reunión detectada</span></div>
    <button class="primary-button" id="start-capture" type="button">${icon("play", { size: 15 })}Iniciar captura</button>
  </div>`;
}

function renderRecording() {
  const sources = isExpanded
    ? `<div class="divider"></div>
      <div class="sources">
        ${sourceRow("file-text", "Transcripción", Boolean(currentMeta.hasTranscript), "Activa", "No disponible")}
        ${sourceRow("volume-2", "Audio de la reunión", true, "Activo", "")}
        ${sourceRow("mic", "Mi voz", !currentMeta.micMuted, "Activa", "Silenciada")}
        ${sourceRow("app-window", "Video de la pestaña", Boolean(currentMeta.videoEnabled), "Activo", "No activo")}
      </div>
      <div class="info-row">${icon("info", { size: 16, color: "var(--text-secondary)" })}<span>Se está grabando la reunión. Puedes detener la captura en cualquier momento.</span></div>`
    : "";

  return `<div class="banner ${isExpanded ? "expanded" : "pill"}">
    <div class="recording-top">
      <div class="recording-copy"><span class="dot" style="background:var(--accent-red)"></span><strong>Asterion</strong><span class="timer">${formatElapsed(currentMeta.startedAt)}</span></div>
      <div class="controls">${recordingControls()}</div>
    </div>
    ${sources}
  </div>`;
}

function renderError() {
  return `<div class="banner pill">
    <div class="recording-copy"><span class="dot" style="background:var(--accent-red)"></span><div class="brand-copy"><strong>Error</strong><span>No se pudo iniciar</span></div></div>
  </div>`;
}

function renderFinished() {
  return `<div class="banner finished">
    <div class="finish-badge"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg></div>
    <div class="brand-copy finish-copy"><strong>Captura finalizada</strong><span>La reunión se guardó correctamente.</span></div>
    <button class="secondary-button" id="view-recording" type="button">Ver grabación ${icon("arrow-up-right", { size: 15 })}</button>
    <button class="icon-button" id="dismiss-banner" type="button" aria-label="Cerrar">${icon("x", { size: 17 })}</button>
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
  if (currentMeta.videoError) console.warn("[Asterion] No se pudo activar video:", currentMeta.videoError);
}

export function showBanner({ onStart, onStop }) {
  callbacks = { onStart, onStop };
  if (hostEl) return;

  hostEl = document.createElement("div");
  hostEl.id = "asterion-banner-host";
  const shadowRoot = hostEl.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL("src/shared/theme.css")}">
    <style>
      #content { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font-family: Inter, system-ui, sans-serif; }
      .banner { min-width: 310px; background: var(--bg); border: 1px solid var(--border); box-shadow: 0 12px 32px var(--shadow); color: var(--text-primary); padding: 12px; }
      .pill { border-radius: 999px; }
      .expanded, .finished { border-radius: 20px; }
      .detected, .recording-top, .recording-copy, .controls, .brand-copy, .source-label, .source-status, .info-row, .finish-badge, .secondary-button, .primary-button, .danger-button, .icon-button { display: flex; align-items: center; }
      .detected, .recording-top { justify-content: space-between; gap: 12px; }
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
      .info-row { gap: 8px; margin-top: 12px; color: var(--text-secondary); font-size: 11px; line-height: 1.35; }
      .finished { display: flex; align-items: center; gap: 10px; min-width: 430px; }
      .finish-badge { justify-content: center; width: 30px; height: 30px; flex: 0 0 auto; border-radius: 50%; background: var(--accent-green); color: #fff; }
      .finish-copy { flex: 1; }
      .finished .icon-button { margin-left: -2px; }
    </style><div id="content"></div>`;
  contentEl = shadowRoot.getElementById("content");
  document.body.appendChild(hostEl);
  render();
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
