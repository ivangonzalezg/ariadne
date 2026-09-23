// src/popup/popup.js
import { icon } from "../shared/icons.js";
import { initI18n } from "../shared/i18n/i18n.js";

const { t } = await initI18n();

const appEl = document.getElementById("app");
let activeTabId = null;
let timerInterval = null;

function formatElapsed(startedAt) {
  const totalSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function sourceRow(iconName, label, active, activeLabel, inactiveLabel) {
  return `<div class="source-row">
    <div class="source-left">${icon(iconName, { size: 16, color: "var(--text-secondary)" })}<span>${label}</span></div>
    <div class="source-status" style="color:${active ? "var(--accent-green)" : "var(--text-muted)"}">
      <span class="dot" style="width:6px;height:6px;background:${active ? "var(--accent-green)" : "var(--text-muted)"}"></span>
      ${active ? activeLabel : inactiveLabel}
    </div>
  </div>`;
}

function footer(autoStart) {
  return `
    <div class="divider"></div>
    <div class="toggle-row">
      <div class="source-left">${icon("monitor", { size: 16, color: "var(--text-secondary)" })}<span style="color:var(--text-primary)">${t("popup.autoDetectLabel")}</span></div>
      <div id="auto-start-toggle" class="toggle" style="background:${autoStart ? "var(--accent-blue)" : "var(--toggle-off)"};justify-content:${autoStart ? "flex-end" : "flex-start"}">
        <div class="toggle-knob"></div>
      </div>
    </div>
    <div class="helper">${t("popup.autoDetectHelper")}</div>
    <div id="history-link" class="link-row">
      <div class="source-left">${icon("history", { size: 16, color: "var(--text-secondary)" })}<span>${t("popup.historyLink")}</span></div>
      ${icon("chevron-right", { size: 16, color: "var(--text-secondary)" })}
    </div>
  `;
}

function header() {
  return `<div class="header">
    <div class="brand"><img src="${chrome.runtime.getURL("icons/icon32.png")}" width="18" height="18" alt="">Ariadne</div>
    <span id="settings-link" role="button" tabindex="0" aria-label="${t("popup.settingsAria")}" style="display:inline-flex;cursor:pointer">${icon("settings", { size: 18, color: "var(--text-secondary)" })}</span>
  </div>`;
}

function conversionProgress(conversionStatus) {
  if (!conversionStatus || conversionStatus.count === 0) return "";

  if (conversionStatus.count > 1) {
    return `<div class="card-box"><div class="source-row"><div class="source-left">${icon("audio-lines", { size: 16, color: "var(--accent-blue)" })}<span>${t("popup.processingMultiple", { count: conversionStatus.count })}</span></div></div></div>`;
  }

  const { stream, pct } = conversionStatus.entries[0];
  const label = stream === "video" ? t("popup.processingLabelVideo") : t("popup.processingLabelAudio");
  const iconName = stream === "video" ? "video" : "audio-lines";
  return `<div class="card-box"><div class="source-row"><div class="source-left">${icon(iconName, { size: 16, color: "var(--accent-blue)" })}<span>${t("popup.processingSingle", { label, pct })}</span></div></div></div>`;
}

function render(status, autoStart, conversionStatus) {
  if (timerInterval) clearInterval(timerInterval);
  const conversionProgressHtml = conversionProgress(conversionStatus);

  if (!status || !status.inMeeting) {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-green)"></span><span class="status-title">${t("popup.statusReady")}</span></div>
      <div class="status-copy">${t("popup.statusReadyCopy")}</div>
      ${footer(autoStart)}
      ${conversionProgressHtml}`;
    wireFooter(autoStart);
    return;
  }

  if (status.state === "idle") {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-blue)"></span><span class="status-title">${t("popup.statusDetected")}</span></div>
      <div class="meeting-name">${status.meetingTitle ?? t("common.untitledMeeting")}</div>
      <button class="primary" id="start-capture">${icon("play", { size: 15 })}${t("popup.startCapture")}</button>
      ${footer(autoStart)}
      ${conversionProgressHtml}`;
    document.getElementById("start-capture").addEventListener("click", () => {
      chrome.tabs.sendMessage(activeTabId, { type: "asterion:popup-start" });
      refresh();
    });
    wireFooter(autoStart);
    return;
  }

  if (status.state === "error") {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-red)"></span><span class="status-title">${t("popup.statusError")}</span></div>
      <div class="status-copy">${t("popup.statusErrorCopy")}</div>
      ${footer(autoStart)}
      ${conversionProgressHtml}`;
    wireFooter(autoStart);
    return;
  }

  // recording / video-enabled
  appEl.innerHTML = `${header()}
    <div class="status-row"><span class="dot" style="background:var(--accent-red)"></span><span class="status-title">${t("popup.statusRecording")}</span></div>
    <div class="meeting-name">${status.meetingTitle ?? t("common.untitledMeeting")}</div>
    <div class="timer" id="timer">00:00</div>
    <div class="card-box">
      ${sourceRow("file-text", t("common.transcript"), status.hasTranscript, t("popup.activeFem"), t("common.notAvailable"))}
      ${sourceRow("volume-2", t("common.audio"), true, t("popup.activeMasc"), "")}
      ${sourceRow("video", t("common.video"), status.videoEnabled, t("popup.activeMasc"), t("popup.notActive"))}
    </div>
    <button class="danger" id="stop-capture">${icon("square", { size: 14 })}${t("popup.stopCapture")}</button>
    ${footer(autoStart)}
    ${conversionProgressHtml}`;
  wireFooter(autoStart);
  document.getElementById("stop-capture").addEventListener("click", () => {
    chrome.tabs.sendMessage(activeTabId, { type: "asterion:popup-stop" });
    refresh();
  });

  const timerEl = document.getElementById("timer");
  const tick = () => { timerEl.textContent = formatElapsed(status.startedAt); };
  tick();
  timerInterval = setInterval(tick, 1000);
}

function wireFooter(autoStart) {
  document.getElementById("auto-start-toggle").addEventListener("click", () => {
    chrome.storage.local.set({ autoStart: !autoStart }, () => refresh());
  });
  document.getElementById("history-link").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/history/history.html") });
  });
  document.getElementById("settings-link").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/settings/settings.html") });
  });
}

async function refresh() {
  const { autoStart } = await chrome.storage.local.get({ autoStart: true });
  const conversionStatus = await chrome.runtime
    .sendMessage({ type: "asterion:get-conversion-status" })
    .catch(() => ({ count: 0, entries: [] }));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.startsWith("https://meet.google.com/")) {
    activeTabId = null;
    render(null, autoStart, conversionStatus);
    return;
  }
  activeTabId = tab.id;
  chrome.tabs.sendMessage(tab.id, { type: "asterion:get-status" }, (response) => {
    render(chrome.runtime.lastError ? null : response, autoStart, conversionStatus);
  });
}

refresh();
setInterval(refresh, 2000);
