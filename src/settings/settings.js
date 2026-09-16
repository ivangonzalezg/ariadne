// src/settings/settings.js
import { icon } from "../shared/icons.js";

const backButton = document.getElementById("back-button");
const videoPresetSelect = document.getElementById("video-preset");

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
