// src/settings/settings.js
import { icon } from "../shared/icons.js";
import { initI18n } from "../shared/i18n/i18n.js";

const { t } = await initI18n();

const backButton = document.getElementById("back-button");
const videoPresetSelect = document.getElementById("video-preset");
const pageHeadingEl = document.getElementById("page-heading");
const videoPresetLabelEl = document.getElementById("video-preset-label");
const videoPresetHelperEl = document.getElementById("video-preset-helper");
const debugLoggingToggle = document.getElementById("debug-logging");
const debugLoggingLabelEl = document.getElementById("debug-logging-label");
const debugLoggingHelperEl = document.getElementById("debug-logging-helper");
const minimumMeetingDurationInput = document.getElementById("minimum-meeting-duration");
const minimumMeetingDurationLabelEl = document.getElementById("minimum-meeting-duration-label");
const minimumMeetingDurationHelperEl = document.getElementById("minimum-meeting-duration-helper");

document.title = t("settings.pageTitle");
backButton.setAttribute("aria-label", t("settings.backAria"));
pageHeadingEl.textContent = t("settings.title");
videoPresetLabelEl.textContent = t("settings.videoPresetLabel");
videoPresetHelperEl.textContent = t("settings.videoPresetHelper");
debugLoggingLabelEl.textContent = t("settings.debugLoggingLabel");
debugLoggingHelperEl.textContent = t("settings.debugLoggingHelper");
minimumMeetingDurationLabelEl.textContent = t("settings.minimumMeetingDurationLabel");
minimumMeetingDurationHelperEl.textContent = t("settings.minimumMeetingDurationHelper");

backButton.innerHTML = icon("chevron-left", { size: 18, color: "var(--text-secondary)" });
backButton.addEventListener("click", () => {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.close();
  }
});

chrome.storage.local.get({ videoPreset: "medium" }, ({ videoPreset }) => {
  videoPresetSelect.value = videoPreset;
});

videoPresetSelect.addEventListener("change", () => {
  chrome.storage.local.set({ videoPreset: videoPresetSelect.value });
});

chrome.storage.local.get({ minimumMeetingDurationSeconds: 0 }, ({ minimumMeetingDurationSeconds }) => {
  minimumMeetingDurationInput.value = Number.isSafeInteger(minimumMeetingDurationSeconds) && minimumMeetingDurationSeconds >= 0 ? minimumMeetingDurationSeconds : 0;
});

minimumMeetingDurationInput.addEventListener("change", () => {
  if (!minimumMeetingDurationInput.reportValidity()) return;
  chrome.storage.local.set({ minimumMeetingDurationSeconds: minimumMeetingDurationInput.valueAsNumber });
});

function renderDebugLoggingToggle(enabled) {
  debugLoggingToggle.setAttribute("aria-checked", String(enabled));
  debugLoggingToggle.style.background = enabled ? "var(--accent-blue)" : "var(--toggle-off)";
  debugLoggingToggle.style.justifyContent = enabled ? "flex-end" : "flex-start";
}

chrome.storage.local.get({ debugLogging: false }, ({ debugLogging }) => {
  renderDebugLoggingToggle(debugLogging);
});

debugLoggingToggle.addEventListener("click", () => {
  const enabled = debugLoggingToggle.getAttribute("aria-checked") !== "true";
  renderDebugLoggingToggle(enabled);
  chrome.storage.local.set({ debugLogging: enabled });
});
