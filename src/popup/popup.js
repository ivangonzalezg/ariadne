import { captionStatusLabel } from "../shared/caption-status.js";
import { icon } from "../shared/icons.js";
import { initI18n } from "../shared/i18n/i18n.js";

const { t } = await initI18n();
const appEl = document.getElementById("app");
let activeTabId = null;
let status = null;
let autoStart = true;
let conversionStatus = null;
let pendingAction = null;
let savingPreference = false;
let actionError = false;
let timerInterval = null;
let refreshTask = null;
let refreshQueued = false;
let actionRevision = 0;
let disposed = false;
let focusReturn = null;

function formatElapsed(startedAt) {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return "00:00";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const pad = value => String(value).padStart(2, "0");
  const time = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:${time}` : time;
}

function sourceRow(name, iconName, label) {
  return `<div class="source-row" data-source="${name}">
    <div class="source-left">${icon(iconName, { size: 16, color: "var(--text-secondary)" })}<span>${label}</span></div>
    <div class="source-status"><span class="dot"></span><span class="source-value"></span></div>
  </div>`;
}

appEl.innerHTML = `
  <div class="header">
    <div class="brand"><img src="${chrome.runtime.getURL("icons/icon32.png")}" width="18" height="18" alt="">Ariadne</div>
    <button id="settings-link" class="settings-button" type="button" aria-label="${t("popup.settingsAria")}">${icon("settings", { size: 18, color: "var(--text-secondary)" })}</button>
  </div>
  <div class="status-row"><span class="dot"></span><span class="status-title" role="status"></span></div>
  <div class="intro">
    <div class="status-copy"></div>
    <div class="meeting-name"></div>
  </div>
  <div class="collapsible recording-region" data-open="false" inert aria-hidden="true"><div class="collapse-inner"><div class="recording-content">
    <div class="timer" id="timer">00:00</div>
    <div class="card-box services">
      ${sourceRow("transcript", "file-text", t("common.transcript"))}
      ${sourceRow("audio", "volume-2", t("common.audio"))}
      ${sourceRow("video", "video", t("common.video"))}
    </div>
  </div></div></div>
  <div class="capture-actions" hidden>
    <div class="action-layer start-layer"><button class="primary" id="start-capture" type="button">${icon("play", { size: 15 })}${t("popup.startCapture")}</button></div>
    <div class="action-layer stop-layer" inert aria-hidden="true"><button class="danger" id="stop-capture" type="button">${icon("square", { size: 14 })}${t("popup.stopCapture")}</button></div>
  </div>
  <div class="action-error" role="alert" hidden>${t("popup.actionError")}</div>
  <div class="footer">
    <div class="divider"></div>
    <div class="toggle-row">
      <div class="source-left" id="auto-start-label">${icon("monitor", { size: 16, color: "var(--text-secondary)" })}<span>${t("popup.autoDetectLabel")}</span></div>
      <button id="auto-start-toggle" class="toggle" type="button" role="switch" aria-labelledby="auto-start-label" aria-describedby="auto-start-helper" aria-checked="false"><span class="toggle-knob"></span></button>
    </div>
    <div class="helper" id="auto-start-helper">${t("popup.autoDetectHelper")}</div>
    <button id="history-link" class="link-row" type="button">
      <span class="source-left">${icon("history", { size: 16, color: "var(--text-secondary)" })}<span>${t("popup.historyLink")}</span></span>
      ${icon("chevron-right", { size: 16, color: "var(--text-secondary)" })}
    </button>
  </div>
  <div class="collapsible conversion-region" data-open="false" inert aria-hidden="true"><div class="collapse-inner"><div class="conversion-content card-box">
    <div class="source-left">
      <span class="conversion-audio">${icon("audio-lines", { size: 16, color: "var(--accent-blue)" })}</span>
      <span class="conversion-video" hidden>${icon("video", { size: 16, color: "var(--accent-blue)" })}</span>
      <span class="conversion-label"></span>
    </div>
  </div></div></div>`;

const elements = {
  title: appEl.querySelector(".status-title"),
  copy: appEl.querySelector(".status-copy"),
  meeting: appEl.querySelector(".meeting-name"),
  recording: appEl.querySelector(".recording-region"),
  timer: appEl.querySelector("#timer"),
  actions: appEl.querySelector(".capture-actions"),
  startLayer: appEl.querySelector(".start-layer"),
  stopLayer: appEl.querySelector(".stop-layer"),
  start: appEl.querySelector("#start-capture"),
  stop: appEl.querySelector("#stop-capture"),
  toggle: appEl.querySelector("#auto-start-toggle"),
  error: appEl.querySelector(".action-error"),
  conversion: appEl.querySelector(".conversion-region"),
};

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function setAccessible(element, visible) {
  element.toggleAttribute("inert", !visible);
  element.setAttribute("aria-hidden", String(!visible));
}

function updateSource(name, active, label) {
  const row = appEl.querySelector(`[data-source="${name}"]`);
  row.querySelector(".source-status").classList.toggle("is-active", Boolean(active));
  setText(row.querySelector(".source-value"), label);
}

function render() {
  if (disposed) return;
  const previousFocus = document.activeElement;
  const inMeeting = Boolean(status?.inMeeting);
  const recording = inMeeting && ["recording", "video-enabled"].includes(status.state);
  const error = inMeeting && status.state === "error";
  const starting = inMeeting && (status.state === "starting" || pendingAction === "start");
  const canStart = inMeeting && ["idle", "starting"].includes(status.state);
  appEl.dataset.recording = String(recording);
  appEl.dataset.state = !inMeeting ? "ready" : status.state;
  let statusKey = "popup.statusDetected";
  if (!inMeeting) statusKey = "popup.statusReady";
  else if (error) statusKey = "popup.statusError";
  else if (recording) statusKey = "popup.statusRecording";
  setText(elements.title, t(statusKey));
  elements.copy.hidden = inMeeting && !error;
  setText(elements.copy, t(error ? "popup.statusErrorCopy" : "popup.statusReadyCopy"));
  elements.meeting.hidden = !inMeeting || error;
  setText(elements.meeting, status?.meetingTitle ?? t("common.untitledMeeting"));
  elements.recording.dataset.open = String(recording);
  setAccessible(elements.recording, recording);
  elements.actions.hidden = !canStart && !recording;
  setAccessible(elements.startLayer, canStart && !recording);
  setAccessible(elements.stopLayer, recording);
  elements.start.disabled = starting || recording || !canStart;
  elements.start.setAttribute("aria-busy", String(starting));
  elements.stop.disabled = pendingAction === "stop" || !recording;
  elements.stop.setAttribute("aria-busy", String(pendingAction === "stop"));
  elements.toggle.disabled = savingPreference;
  elements.toggle.setAttribute("aria-busy", String(savingPreference));
  elements.toggle.setAttribute("aria-checked", String(autoStart));
  elements.error.hidden = !actionError;
  updateSource("transcript", status?.transcriptActive && !status?.captionStorage?.error, captionStatusLabel(status ?? {}, t));
  updateSource("audio", recording, t("popup.activeMasc"));
  updateSource("video", status?.videoEnabled, t(status?.videoEnabled ? "popup.activeMasc" : "popup.notActive"));
  if (recording) setText(elements.timer, formatElapsed(status?.startedAt));
  if (recording && timerInterval === null) {
    timerInterval = setInterval(() => { setText(elements.timer, formatElapsed(status?.startedAt)); }, 1000);
  } else if (!recording && timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  const count = conversionStatus?.count ?? 0;
  const entry = conversionStatus?.entries?.[0];
  const video = count === 1 && entry?.stream === "video";
  elements.conversion.dataset.open = String(count > 0);
  setAccessible(elements.conversion, count > 0);
  appEl.querySelector(".conversion-audio").hidden = video;
  appEl.querySelector(".conversion-video").hidden = !video;
  const label = count > 1 ? t("popup.processingMultiple", { count }) : entry ? t("popup.processingSingle", {
    label: t(video ? "popup.processingLabelVideo" : "popup.processingLabelAudio"), pct: entry.pct,
  }) : "";
  // Keep the last text during the closing fade.
  if (count > 0) setText(appEl.querySelector(".conversion-label"), label);
  if (appEl.contains(previousFocus) && (
    previousFocus.closest("[inert], [hidden]") || previousFocus.disabled
  )) {
    focusReturn = previousFocus;
    let destination = appEl.querySelector("#settings-link");
    if (starting || pendingAction === "stop" || savingPreference) destination = appEl;
    else if (recording && !elements.stop.disabled) destination = elements.stop;
    else if (canStart && !elements.start.disabled) destination = elements.start;
    destination.focus({ preventScroll: true });
  } else if (previousFocus === appEl && !pendingAction && !starting && !savingPreference) {
    let destination = appEl.querySelector("#settings-link");
    if (focusReturn && !focusReturn.disabled && !focusReturn.closest("[inert], [hidden]")) destination = focusReturn;
    else if (recording) destination = elements.stop;
    else if (canStart) destination = elements.start;
    destination.focus({ preventScroll: true });
    focusReturn = null;
  }
}

async function captureAction(action) {
  if (pendingAction || activeTabId === null) return;
  const tabId = activeTabId;
  pendingAction = action;
  actionError = false;
  actionRevision++;
  render();
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: `asterion:popup-${action}` });
    if (!response?.ok) throw new Error("Capture action was not accepted");
  } catch {
    if (activeTabId === tabId) { actionRevision++; pendingAction = null; actionError = true; render(); }
  }
  await refresh();
}

async function toggleAutoStart() {
  if (savingPreference) return;
  const previous = autoStart;
  savingPreference = true;
  actionError = false;
  autoStart = !autoStart;
  actionRevision++;
  render();
  try {
    await chrome.storage.local.set({ autoStart });
  } catch {
    autoStart = previous;
    actionError = true;
  } finally {
    actionRevision++;
    savingPreference = false;
    render();
  }
  await refresh();
}

elements.start.addEventListener("click", () => captureAction("start"));
elements.stop.addEventListener("click", () => captureAction("stop"));
elements.toggle.addEventListener("click", toggleAutoStart);
for (const [id, path] of [["history-link", "history"], ["settings-link", "settings"]]) {
  appEl.querySelector(`#${id}`).addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`src/${path}/${path}.html`) });
  });
}

async function readSnapshot() {
  const revision = actionRevision;
  const [preferences, conversion, tabs] = await Promise.all([
    chrome.storage.local.get({ autoStart: true }),
    chrome.runtime.sendMessage({ type: "asterion:get-conversion-status" }).catch(() => ({ count: 0, entries: [] })),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  const tab = tabs[0];
  const tabId = tab?.url?.startsWith("https://meet.google.com/") ? tab.id : null;
  const nextStatus = tabId === null ? null : await chrome.tabs.sendMessage(tabId, { type: "asterion:get-status" });
  if (disposed || revision !== actionRevision) { refreshQueued = !disposed; return; }
  if (activeTabId !== tabId || !nextStatus?.inMeeting || nextStatus.state === "error") pendingAction = null;
  if (pendingAction === "start" && ["starting", "recording", "video-enabled"].includes(nextStatus?.state)) pendingAction = null;
  if (pendingAction === "stop" && !["recording", "video-enabled"].includes(nextStatus?.state)) pendingAction = null;
  activeTabId = tabId;
  status = nextStatus;
  if (!savingPreference) autoStart = preferences.autoStart;
  conversionStatus = conversion;
  render();
  if (!appEl.hasAttribute("data-ready")) {
    // Commit the first snapshot without animating the popup's initial appearance.
    appEl.getBoundingClientRect();
    appEl.dataset.ready = "true";
  }
}

export function refresh() {
  if (disposed) return Promise.resolve();
  refreshQueued = true;
  if (refreshTask) return refreshTask;
  refreshTask = (async () => {
    while (refreshQueued && !disposed) {
      refreshQueued = false;
      const revision = actionRevision;
      try { await readSnapshot(); }
      catch {
        if (revision !== actionRevision) { refreshQueued = !disposed; continue; }
        if (!disposed) { pendingAction = null; actionError = true; render(); appEl.dataset.ready = "true"; }
      }
    }
  })().finally(() => { refreshTask = null; });
  return refreshTask;
}

const pollingInterval = setInterval(refresh, 2000);
window.addEventListener("pagehide", () => {
  disposed = true;
  clearInterval(pollingInterval);
  clearInterval(timerInterval);
}, { once: true });
await refresh();
