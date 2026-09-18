// src/popup/popup.js
import { icon } from "../shared/icons.js";

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
      <div class="source-left">${icon("monitor", { size: 16, color: "var(--text-secondary)" })}<span style="color:var(--text-primary)">Detectar reuniones en Meet</span></div>
      <div id="auto-start-toggle" class="toggle" style="background:${autoStart ? "var(--accent-blue)" : "var(--toggle-off)"};justify-content:${autoStart ? "flex-end" : "flex-start"}">
        <div class="toggle-knob"></div>
      </div>
    </div>
    <div class="helper">Inicia la captura sola al entrar a una llamada de Meet. Esto aplica a cualquier reunión, no solo a la actual.</div>
    <div id="history-link" class="link-row">
      <div class="source-left">${icon("history", { size: 16, color: "var(--text-secondary)" })}<span>Ver historial</span></div>
      ${icon("chevron-right", { size: 16, color: "var(--text-secondary)" })}
    </div>
  `;
}

function header() {
  return `<div class="header">
    <div class="brand"><img src="${chrome.runtime.getURL("icons/icon32.png")}" width="18" height="18" alt="">Asterion</div>
    <span id="settings-link" role="button" tabindex="0" aria-label="Configuración" style="display:inline-flex;cursor:pointer">${icon("settings", { size: 18, color: "var(--text-secondary)" })}</span>
  </div>`;
}

function render(status, autoStart) {
  if (timerInterval) clearInterval(timerInterval);

  if (!status || !status.inMeeting) {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-green)"></span><span class="status-title">Listo</span></div>
      <div class="status-copy">Abre una reunión de Google Meet para comenzar.</div>
      ${footer(autoStart)}`;
    wireFooter(autoStart);
    return;
  }

  if (status.state === "idle") {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-blue)"></span><span class="status-title">Reunión detectada</span></div>
      <div class="status-copy">Iniciá la captura cuando quieras.</div>
      <div class="card-box">
        <div class="source-left">${icon("monitor", { size: 16, color: "var(--accent-blue)" })}<span style="color:var(--text-secondary);font-size:12px">Reunión en curso</span></div>
        <div class="meeting-name">${status.meetingTitle ?? "Reunión sin título"}</div>
        <button class="primary" id="start-capture">${icon("play", { size: 15 })}Iniciar captura</button>
      </div>
      ${footer(autoStart)}`;
    document.getElementById("start-capture").addEventListener("click", () => {
      chrome.tabs.sendMessage(activeTabId, { type: "asterion:popup-start" });
      refresh();
    });
    wireFooter(autoStart);
    return;
  }

  if (status.state === "error") {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-red)"></span><span class="status-title">Error</span></div>
      <div class="status-copy">No se pudo iniciar la grabación. Volvé a intentarlo.</div>
      ${footer(autoStart)}`;
    wireFooter(autoStart);
    return;
  }

  // recording / video-enabled
  appEl.innerHTML = `${header()}
    <div class="status-row"><span class="dot" style="background:var(--accent-red)"></span><span class="status-title">Grabando</span></div>
    <div class="meeting-name">${status.meetingTitle ?? "Reunión sin título"}</div>
    <div class="timer" id="timer">00:00</div>
    <div class="card-box">
      ${sourceRow("file-text", "Transcripción", status.hasTranscript, "Activa", "No disponible")}
      ${sourceRow("volume-2", "Audio de la reunión", true, "Activo", "")}
      ${sourceRow("mic", "Mi voz", !status.micMuted, "Activa", "Silenciada")}
      ${sourceRow("app-window", "Video de la pestaña", status.videoEnabled, "Activo", "No activo")}
    </div>
    <button class="danger" id="stop-capture">${icon("square", { size: 14 })}Detener captura</button>
    ${footer(autoStart)}`;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.startsWith("https://meet.google.com/")) {
    activeTabId = null;
    render(null, autoStart);
    return;
  }
  activeTabId = tab.id;
  chrome.tabs.sendMessage(tab.id, { type: "asterion:get-status" }, (response) => {
    render(chrome.runtime.lastError ? null : response, autoStart);
  });
}

refresh();
setInterval(refresh, 2000);
