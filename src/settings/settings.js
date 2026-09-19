// src/settings/settings.js
import { icon } from "../shared/icons.js";
import { initI18n } from "../shared/i18n/i18n.js";

const { t } = await initI18n();

const backButton = document.getElementById("back-button");
const videoPresetSelect = document.getElementById("video-preset");
const pageHeadingEl = document.getElementById("page-heading");
const videoPresetLabelEl = document.getElementById("video-preset-label");
const videoPresetHelperEl = document.getElementById("video-preset-helper");

document.title = t("settings.pageTitle");
backButton.setAttribute("aria-label", t("settings.backAria"));
pageHeadingEl.textContent = t("settings.title");
videoPresetLabelEl.textContent = t("settings.videoPresetLabel");
videoPresetHelperEl.textContent = t("settings.videoPresetHelper");

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
