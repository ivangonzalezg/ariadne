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

function bindPreference(control, key, fallback, read, render, valid = () => true) {
  const status = document.createElement("p"); status.className = "setting-status"; status.id = `${control.id}-status`; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const retry = document.createElement("button"); retry.type = "button"; retry.className = "retry-setting"; retry.textContent = t("settings.retry"); retry.hidden = true;
  control.closest(".setting-card").append(status, retry);
  control.setAttribute("aria-describedby", [control.getAttribute("aria-describedby"), status.id].filter(Boolean).join(" "));
  let confirmed = fallback, pending = false, loaded = false, timer, retryAction, ownedFocus = false;
  const show = (message, failed = false) => { status.textContent = message; status.classList.toggle("is-error", failed); retry.hidden = !failed; };
  const busy = value => {
    if (value) ownedFocus = document.activeElement === control || document.activeElement === retry;
    pending = value; control.disabled = value || !loaded; retry.disabled = value; control.setAttribute("aria-busy", String(value));
    if (!value && loaded && ownedFocus && document.activeElement === document.body) control.focus({ preventScroll: true });
  };
  const load = async () => {
    if (pending) return;
    clearTimeout(timer); busy(true); show(t("settings.loading"));
    try {
      const result = await chrome.storage.local.get({ [key]: fallback });
      confirmed = result[key]; loaded = true; render(confirmed); show("");
    } catch { retryAction = load; show(t("settings.loadError"), true); }
    finally { busy(false); }
  };
  const save = async value => {
    if (pending || !loaded || !valid()) return;
    clearTimeout(timer); render(value); busy(true); show(t("settings.saving"));
    try {
      await chrome.storage.local.set({ [key]: value });
      confirmed = value; show(t("settings.saved")); timer = setTimeout(() => show(""), 2000);
    } catch { render(confirmed); retryAction = () => save(value); show(t("settings.saveError"), true); }
    finally { busy(false); }
  };
  control.addEventListener(control === debugLoggingToggle ? "click" : "change", () => save(read()));
  retry.addEventListener("click", () => retryAction?.());
  window.addEventListener("pagehide", () => clearTimeout(timer), { once: true });
  load();
}
bindPreference(videoPresetSelect, "videoPreset", "medium", () => videoPresetSelect.value, value => { videoPresetSelect.value = value; });
bindPreference(minimumMeetingDurationInput, "minimumMeetingDurationSeconds", 0, () => minimumMeetingDurationInput.valueAsNumber, value => {
  minimumMeetingDurationInput.value = Number.isSafeInteger(value) && value >= 0 ? value : 0;
}, () => minimumMeetingDurationInput.reportValidity());
bindPreference(debugLoggingToggle, "debugLogging", false, () => debugLoggingToggle.getAttribute("aria-checked") !== "true", value => {
  debugLoggingToggle.setAttribute("aria-checked", String(Boolean(value)));
});
