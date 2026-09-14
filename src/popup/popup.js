// src/popup/popup.js
import { CaptionParser } from "../lib/caption-parser.js";

const autoStartCheckboxEl = document.getElementById("auto-start");
const meetingStatusEl = document.getElementById("meeting-status");
const startButtonEl = document.getElementById("start-recording");
const stopButtonEl = document.getElementById("stop-recording");
const transcriptEl = document.getElementById("transcript");

const captionParser = new CaptionParser();
let activeTabId = null;

chrome.storage.local.get({ autoStart: true }, ({ autoStart }) => {
  autoStartCheckboxEl.checked = autoStart;
});
autoStartCheckboxEl.addEventListener("change", () => {
  chrome.storage.local.set({ autoStart: autoStartCheckboxEl.checked });
});

const STATUS_LABELS = {
  idle: "Sin grabar.",
  starting: "Iniciando…",
  recording: "Grabando.",
  "video-enabled": "Grabando con video.",
  error: "Error al iniciar.",
};

function renderMeetingStatus(status) {
  if (!status || !status.inMeeting) {
    meetingStatusEl.textContent = "No hay una reunión de Meet activa en esta pestaña.";
    startButtonEl.style.display = "none";
    stopButtonEl.style.display = "none";
    return;
  }
  meetingStatusEl.textContent = STATUS_LABELS[status.state] ?? status.state;
  startButtonEl.style.display = status.state === "idle" || status.state === "error" ? "inline-block" : "none";
  stopButtonEl.style.display =
    status.state === "recording" || status.state === "video-enabled" ? "inline-block" : "none";
}

async function refreshMeetingStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.startsWith("https://meet.google.com/")) {
    activeTabId = null;
    renderMeetingStatus(null);
    return;
  }
  activeTabId = tab.id;
  chrome.tabs.sendMessage(tab.id, { type: "asterion:get-status" }, (response) => {
    if (chrome.runtime.lastError) {
      renderMeetingStatus(null);
      return;
    }
    renderMeetingStatus(response);
  });
}

startButtonEl.addEventListener("click", () => {
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: "asterion:popup-start" });
});
stopButtonEl.addEventListener("click", () => {
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: "asterion:popup-stop" });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:caption-snapshot") {
    captionParser.onSnapshot(message.snapshot);
    renderTranscript();
  }
});

function renderTranscript() {
  const lines = captionParser.finishedSegments.map((s) => `[${s.speaker}] ${s.text}`);
  if (captionParser.current) lines.push(`[${captionParser.current.speaker}] ${captionParser.current.text}`);
  transcriptEl.textContent = lines.join("\n") || "(sin transcripción todavía)";
}

document.getElementById("open-history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/history/history.html") });
});

refreshMeetingStatus();
setInterval(refreshMeetingStatus, 2000);
