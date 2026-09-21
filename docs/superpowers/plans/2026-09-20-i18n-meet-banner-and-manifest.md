# i18n for the Meet banner and extension metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-specific override:** in this repo, tasks are delegated to and executed by the `codex:codex-rescue` agent (Codex), not by generic Claude subagents — see `CLAUDE.md`. Claude reviews each task's result against this plan before moving to the next one.

**Goal:** Finish internationalizing Asterion by translating the two remaining hardcoded-Spanish surfaces: the on-page recording banner injected into Google Meet (`src/content/meet-banner.js`), and the extension's own name/description as shown in `chrome://extensions` and the Chrome Web Store listing.

**Architecture:** Two independent, unrelated mechanisms, because the two surfaces are fundamentally different:
- The Meet banner reuses the exact same custom i18n module built for the popup/settings/history pages (`src/shared/i18n/i18n.js`, `initI18n()`), extended so its runtime-fetched locale JSON files are reachable from a content script injected into `https://meet.google.com/*` (via `web_accessible_resources`).
- The extension name/description use Chrome's own native, built-in localization mechanism (`default_locale` + `_locales/<lang>/messages.json` + `__MSG_key__` placeholders in `manifest.json`). This is declarative — Chrome itself picks the closest-matching locale from the browser's language settings and falls back to `default_locale` automatically, with no JavaScript involved. This is the officially supported way to localize manifest-level strings and happens to give exactly the "closest match, fallback to English" behavior the whole feature was built around — Chrome just does it natively for this one surface.

**Tech Stack:** Same as the parent i18n feature — vanilla JS, `fetch` + `chrome.runtime.getURL`, Vitest with `jsdom`. Task 2 adds no JS at all, just manifest/JSON changes.

**Context:** This plan builds directly on `docs/superpowers/plans/2026-09-19-i18n-extension.md`, which is already fully implemented and committed (`src/shared/i18n/i18n.js`, `src/shared/i18n/locales/{en,es,fr}.json`, and the translated popup/settings/history pages). Nothing in that infrastructure needs to change; Task 1 below only adds to `web_accessible_resources` and to the three locale JSON files.

---

## Key → text mapping for the Meet banner

Reuse these existing keys as-is (already defined in `src/shared/i18n/locales/{en,es,fr}.json`, no changes needed): `popup.statusDetected`, `popup.startCapture`, `common.transcript`, `popup.activeFem`, `common.notAvailable`, `common.meetingAudioLabel`, `popup.activeMasc`, `popup.micLabel`, `popup.micMutedLabel`, `popup.tabVideoLabel`, `popup.notActive`, `popup.statusError`.

New keys to add to all three dictionaries (namespace `banner.*`):

| Key | es (original) | en | fr |
|---|---|---|---|
| banner.enableVideoAria | Activar video | Enable video | Activer la vidéo |
| banner.collapseAria | Contraer | Collapse | Réduire |
| banner.expandAria | Expandir | Expand | Développer |
| banner.stopButton | Detener | Stop | Arrêter |
| banner.recordingInfo | Se está grabando la reunión. Puedes detener la captura en cualquier momento. | The meeting is being recorded. You can stop capture at any time. | La réunion est en cours d'enregistrement. Vous pouvez arrêter la capture à tout moment. |
| banner.errorCopy | No se pudo iniciar | Could not start | Impossible de démarrer |
| banner.finishedTitle | Captura finalizada | Capture finished | Capture terminée |
| banner.finishedCopy | La reunión se guardó correctamente. | The meeting was saved successfully. | La réunion a été enregistrée avec succès. |
| banner.viewRecording | Ver grabación | View recording | Voir l'enregistrement |
| banner.dismissAria | Cerrar | Close | Fermer |
| banner.videoErrorLog | [Asterion] No se pudo activar video: | [Asterion] Could not enable video: | [Asterion] Impossible d'activer la vidéo : |

`"Asterion"` (brand name) and `"Error"`'s sibling `popup.statusError` reuse stay as-is; `"Error"` itself as a bare word already exists as `popup.statusError`.

---

### Task 1: Translate the Meet on-page banner

**Files:**
- Modify: `src/content/meet-banner.js`
- Modify: `src/shared/i18n/locales/en.json`
- Modify: `src/shared/i18n/locales/es.json`
- Modify: `src/shared/i18n/locales/fr.json`
- Modify: `manifest.json`
- Modify: `src/shared/i18n/i18n.test.js`
- Test: `src/content/meet-banner.test.js`

- [ ] **Step 1: Add the 11 new `banner.*` keys to all three dictionaries**

In `src/shared/i18n/locales/en.json`, add these entries (anywhere in the object, e.g. appended before the closing `}`):

```json
  "banner.enableVideoAria": "Enable video",
  "banner.collapseAria": "Collapse",
  "banner.expandAria": "Expand",
  "banner.stopButton": "Stop",
  "banner.recordingInfo": "The meeting is being recorded. You can stop capture at any time.",
  "banner.errorCopy": "Could not start",
  "banner.finishedTitle": "Capture finished",
  "banner.finishedCopy": "The meeting was saved successfully.",
  "banner.viewRecording": "View recording",
  "banner.dismissAria": "Close",
  "banner.videoErrorLog": "[Asterion] Could not enable video:"
```

In `src/shared/i18n/locales/es.json`, add:

```json
  "banner.enableVideoAria": "Activar video",
  "banner.collapseAria": "Contraer",
  "banner.expandAria": "Expandir",
  "banner.stopButton": "Detener",
  "banner.recordingInfo": "Se está grabando la reunión. Puedes detener la captura en cualquier momento.",
  "banner.errorCopy": "No se pudo iniciar",
  "banner.finishedTitle": "Captura finalizada",
  "banner.finishedCopy": "La reunión se guardó correctamente.",
  "banner.viewRecording": "Ver grabación",
  "banner.dismissAria": "Cerrar",
  "banner.videoErrorLog": "[Asterion] No se pudo activar video:"
```

In `src/shared/i18n/locales/fr.json`, add:

```json
  "banner.enableVideoAria": "Activer la vidéo",
  "banner.collapseAria": "Réduire",
  "banner.expandAria": "Développer",
  "banner.stopButton": "Arrêter",
  "banner.recordingInfo": "La réunion est en cours d'enregistrement. Vous pouvez arrêter la capture à tout moment.",
  "banner.errorCopy": "Impossible de démarrer",
  "banner.finishedTitle": "Capture terminée",
  "banner.finishedCopy": "La réunion a été enregistrée avec succès.",
  "banner.viewRecording": "Voir l'enregistrement",
  "banner.dismissAria": "Fermer",
  "banner.videoErrorLog": "[Asterion] Impossible d'activer la vidéo :"
```

Every JSON file must remain valid (comma-separated, no trailing comma after the last key) — run `python3 -c "import json; json.load(open('src/shared/i18n/locales/en.json'))"` (and the same for `es.json`/`fr.json`) to confirm each parses.

- [ ] **Step 1b: Strengthen the existing dictionary-completeness test to catch a key missing from just one locale**

The dictionary-completeness test added by the parent plan (in `src/shared/i18n/i18n.test.js`) only checks that `es`/`fr` don't define keys absent from `en` — it does **not** catch the opposite mistake (a key added to `en` but forgotten in `es` or `fr`), which is exactly the kind of error a manual three-file edit like Step 1 above can introduce. Codex's review flagged this gap. Fix it now, before relying on that test to catch a mistake in Step 1.

In `src/shared/i18n/i18n.test.js`, change:

```js
describe("dictionary completeness", () => {
  it("only ever defines keys in es/fr that also exist in the English dictionary", () => {
    const enKeys = new Set(Object.keys(enDict));
    for (const key of Object.keys(esDict)) expect(enKeys.has(key)).toBe(true);
    for (const key of Object.keys(frDict)) expect(enKeys.has(key)).toBe(true);
  });
});
```

to:

```js
describe("dictionary completeness", () => {
  it("only ever defines keys in es/fr that also exist in the English dictionary", () => {
    const enKeys = new Set(Object.keys(enDict));
    for (const key of Object.keys(esDict)) expect(enKeys.has(key)).toBe(true);
    for (const key of Object.keys(frDict)) expect(enKeys.has(key)).toBe(true);
  });

  it("defines every English key in the Spanish and French dictionaries too (no missing translations)", () => {
    const esKeys = new Set(Object.keys(esDict));
    const frKeys = new Set(Object.keys(frDict));
    for (const key of Object.keys(enDict)) {
      expect(esKeys.has(key)).toBe(true);
      expect(frKeys.has(key)).toBe(true);
    }
  });
});
```

Run: `npx vitest run src/shared/i18n/i18n.test.js`
Expected: PASS — this should already pass once Step 1's three dictionaries all have the same 11 new keys added correctly. If it fails, a `banner.*` key was added to `en.json` but missed in `es.json` or `fr.json` (or vice versa) — go back and fix Step 1 before continuing.

- [ ] **Step 2: Add the locale JSON files to `web_accessible_resources` for the Meet content script**

In `manifest.json`, change:

```json
  "web_accessible_resources": [
    {
      "resources": ["src/shared/theme.css", "icons/icon32.png"],
      "matches": ["https://meet.google.com/*"]
    }
  ],
```

to:

```json
  "web_accessible_resources": [
    {
      "resources": [
        "src/shared/theme.css",
        "icons/icon32.png",
        "src/shared/i18n/locales/en.json",
        "src/shared/i18n/locales/es.json",
        "src/shared/i18n/locales/fr.json"
      ],
      "matches": ["https://meet.google.com/*"]
    }
  ],
```

`src/shared/i18n/i18n.js` itself does **not** need to be listed here — it gets bundled directly into `dist/content.bundle.js` by esbuild (since `meet-banner.js` imports it and `meet-banner.js` is imported by `meet-detector.js`, the content script's bundle entry point), so it's never fetched over the network at runtime. Only the three JSON dictionaries are fetched live via `chrome.runtime.getURL` + `fetch`, and only resources reachable that way need to be web-accessible.

- [ ] **Step 3: Translate meet-banner.js**

**Important — this file is bundled without `--format=esm`** (see `package.json`'s `build:content` script: `esbuild src/content/meet-detector.js --bundle --outfile=dist/content.bundle.js`, no `--format` flag, unlike `build:offscreen` which passes `--format=esm`). That means, unlike `popup.js`/`settings.js`/`history.js`, this file **cannot use top-level `await`** — only `async function` bodies with `await` inside them, which work in any bundle format (confirmed by Codex's review: only *top-level* await requires ESM output; `await` inside a function body is fine in an IIFE bundle). `showBanner()` becomes `async` and awaits `initI18n()` once, caching the returned `t` in module scope for every render function to use. A boolean guard (`bannerReady`), set synchronously *before* the `await`, prevents a second call to `showBanner()` — which already had a synchronous `if (hostEl) return;` idempotency guard — from slipping through and creating a duplicate banner while the first call's `await initI18n()` is still pending.

**Failure handling (added after Codex's review):** `initI18n()` is not expected to reject under normal use — Task 1 of the parent plan already made `fetchDictionary` failures fall back silently to `{}` inside `safeFetchDictionary`, so a missing/corrupted locale JSON degrades to raw-key rendering rather than throwing. But `showBanner()` still wraps the `await initI18n()` in a `try/catch` as defense in depth: if it ever does reject for an unforeseen reason, `bannerReady` is reset to `false` in the `catch` block so a later call can retry, instead of permanently wedging the banner in a state where `bannerReady` is `true` but `hostEl` was never created.

Replace the full contents of `src/content/meet-banner.js` with:

```js
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
    <div class="brand-copy"><strong>Asterion</strong><span>${t("popup.statusDetected")}</span></div>
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
      <div class="recording-copy"><img class="brand-icon" src="${chrome.runtime.getURL("icons/icon32.png")}" alt="" width="20" height="20"><strong>Asterion</strong><span class="timer">${formatElapsed(currentMeta.startedAt)}</span></div>
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
    console.error("[Asterion] i18n initialization failed for the Meet banner", error);
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
```

The only logic changes from the original are: the two new imports/module-level variables (`bannerReady`, `t`), `showBanner` becoming `async` with the `try/catch`-wrapped `await initI18n()` call and the `bannerReady` guard, and every hardcoded Spanish string replaced with the matching `t(...)` call. Nothing else — no DOM structure, event wiring, drag/positioning logic changed. `showBanner()` now returns a `Promise` (it didn't before) — callers in `meet-detector.js` don't need to change for this, since `showBanner(...)` is still called without `await` there and nothing depended on it completing synchronously; the returned promise is simply left unused, same as any other fire-and-forget async call.

- [ ] **Step 4: Write a smoke test**

**Note (revised after Codex's review):** the first draft of this test relied on Vitest's module cache carrying `hostEl`/`bannerReady` state over from one `it` block to the next within the same file, and asserted idempotency by observing that leftover state — that doesn't actually exercise the concurrent-call race the `bannerReady` guard exists for (a second `showBanner()` call arriving *after* the first one has already fully finished isn't the risky case; a second call arriving *while the first one's `await initI18n()` is still pending* is). The version below instead calls `vi.resetModules()` before each test to get a fresh module instance, cleans up the DOM in `afterEach`, and — for the concurrency test specifically — holds the mocked `fetch` call pending with a manually-resolved "gate" promise so both `showBanner()` calls genuinely race before either dictionary fetch resolves.

Create `src/content/meet-banner.test.js`:

```js
import { afterEach, describe, expect, it, vi } from "vitest";

function mockChrome() {
  globalThis.chrome = {
    runtime: { getURL: (path) => path },
    storage: {
      local: {
        get: (defaults, callback) => callback(defaults),
        set: () => {},
      },
    },
    tabs: { create: () => {} },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe("showBanner", () => {
  it("renders the detected-state copy, including a banner-specific key, once initI18n resolves", async () => {
    vi.resetModules();
    mockChrome();
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        "popup.statusDetected": "Meeting detected",
        "popup.startCapture": "Start capture",
        "banner.stopButton": "Stop",
      }),
    }));

    const { showBanner } = await import("./meet-banner.js");
    await showBanner({ onStart: () => {}, onStop: () => {} });

    const host = document.getElementById("asterion-banner-host");
    expect(host).not.toBeNull();
    const content = host.shadowRoot.getElementById("content").innerHTML;
    expect(content).toContain("Meeting detected");
    expect(content).toContain("Start capture");
  });

  it("renders in Spanish when the browser locale is es, including a banner-specific key", async () => {
    vi.resetModules();
    mockChrome();
    globalThis.fetch = vi.fn((url) => {
      const dict = String(url).includes("/es.json")
        ? { "popup.statusDetected": "Reunión detectada", "popup.startCapture": "Iniciar captura", "banner.stopButton": "Detener" }
        : { "popup.statusDetected": "Meeting detected", "popup.startCapture": "Start capture", "banner.stopButton": "Stop" };
      return Promise.resolve({ ok: true, status: 200, json: async () => dict });
    });
    const originalLanguage = navigator.language;
    Object.defineProperty(navigator, "language", { value: "es-AR", configurable: true });

    const { showBanner } = await import("./meet-banner.js");
    await showBanner({ onStart: () => {}, onStop: () => {} });

    const host = document.getElementById("asterion-banner-host");
    const content = host.shadowRoot.getElementById("content").innerHTML;
    expect(content).toContain("Reunión detectada");
    expect(content).toContain("Iniciar captura");

    Object.defineProperty(navigator, "language", { value: originalLanguage, configurable: true });
  });

  it("creates exactly one banner host when called twice before initI18n resolves", async () => {
    vi.resetModules();
    mockChrome();
    const fetchGate = deferred();
    globalThis.fetch = vi.fn(() => fetchGate.promise);

    const { showBanner } = await import("./meet-banner.js");
    const first = showBanner({ onStart: () => {}, onStop: () => {} });
    const second = showBanner({ onStart: () => {}, onStop: () => {} });

    fetchGate.resolve({
      ok: true,
      status: 200,
      json: async () => ({ "popup.statusDetected": "Meeting detected", "popup.startCapture": "Start capture" }),
    });
    await Promise.all([first, second]);

    expect(document.querySelectorAll("#asterion-banner-host").length).toBe(1);
  });
});
```

Run: `npx vitest run src/content/meet-banner.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full test suite and the build**

Run: `npm test`
Expected: PASS, all suites green including the new `meet-banner.test.js`.

Run: `npm run build`
Expected: succeeds — `dist/content.bundle.js` now includes `i18n.js`'s code bundled in.

- [ ] **Step 6: Verify no hardcoded Spanish text was missed**

Run:
```bash
grep -noiE '"[^"]*(reunion|reuniones|volver|buscar|cancelar|eliminar|guardad|dispositivo|archivo|descargar|abrir|activa|activo|silenciada|listo|grabando|configuracion|historial|resultados|todavia|seleccion|cargando|volumen|posicion|pantalla|completa|contraer|expandir|detener|iniciar|finalizada|correctamente|grabacion|cerrar)[^"]*"' src/content/meet-banner.js
```
Expected: no output. (This targets common Spanish words directly, since the naive `[a-záéíóúñ]` character-class approach used in the parent plan also matches plain ASCII letters and is too noisy to be useful as a check.)

- [ ] **Step 7: Commit**

```bash
git add src/content/meet-banner.js src/content/meet-banner.test.js src/shared/i18n/locales src/shared/i18n/i18n.test.js manifest.json
git commit -m "feat: translate the Meet on-page banner via i18n module"
```

---

### Task 2: Localize the extension's name and description via Chrome's native `_locales`

**Files:**
- Create: `_locales/en/messages.json`
- Create: `_locales/es/messages.json`
- Create: `_locales/fr/messages.json`
- Modify: `manifest.json`
- Test: `manifest.test.js`
- Test: `_locales/messages.test.js`

This is a completely separate mechanism from Task 1 — Chrome's built-in extension localization, not the custom `i18n.js` module. It only affects the `name`/`description` shown in `chrome://extensions` and the Chrome Web Store; it does not affect any in-page UI. There is no way to unit-test Chrome's own placeholder resolution (that only happens inside the browser when it loads the extension), so this task's automated tests only check that the JSON/manifest are well-formed and internally consistent; the actual placeholder resolution needs the manual check in Step 5.

- [ ] **Step 1: Create the three `_locales/<lang>/messages.json` files**

Create `_locales/en/messages.json`:

```json
{
  "extensionName": {
    "message": "Asterion — Meeting Capture",
    "description": "Extension name shown in the Chrome Web Store and chrome://extensions."
  },
  "extensionDescription": {
    "message": "Automatic local capture of transcript, audio, and video from Google Meet meetings.",
    "description": "Extension description shown in the Chrome Web Store and chrome://extensions."
  }
}
```

Create `_locales/es/messages.json`:

```json
{
  "extensionName": {
    "message": "Asterion — Captura de Reuniones",
    "description": "Nombre de la extensión mostrado en la Chrome Web Store y en chrome://extensions."
  },
  "extensionDescription": {
    "message": "Captura local automática de transcripción, audio y video de reuniones de Google Meet.",
    "description": "Descripción de la extensión mostrada en la Chrome Web Store y en chrome://extensions."
  }
}
```

Create `_locales/fr/messages.json`:

```json
{
  "extensionName": {
    "message": "Asterion — Capture de Réunions",
    "description": "Nom de l'extension affiché dans le Chrome Web Store et sur chrome://extensions."
  },
  "extensionDescription": {
    "message": "Capture locale automatique de la transcription, de l'audio et de la vidéo des réunions Google Meet.",
    "description": "Description de l'extension affichée dans le Chrome Web Store et sur chrome://extensions."
  }
}
```

- [ ] **Step 2: Wire manifest.json to use them**

In `manifest.json`, add a top-level `"default_locale": "en"` key (place it right after `"manifest_version"`, order doesn't matter to Chrome but keep it near the top for readability), and change the existing `"name"` and `"description"` values:

Change:
```json
  "manifest_version": 3,
  "name": "Asterion — Captura de Reuniones",
  "version": "0.1.6",
  "description": "Captura local automática de transcripción, audio y video de reuniones de Google Meet.",
```
to:
```json
  "manifest_version": 3,
  "default_locale": "en",
  "name": "__MSG_extensionName__",
  "version": "0.1.6",
  "description": "__MSG_extensionDescription__",
```

- [ ] **Step 3: Write the tests**

Create `manifest.test.js` (at the repo root, alongside `manifest.json`):

```js
import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";

describe("manifest.json localization", () => {
  it("declares default_locale so chrome.i18n can resolve __MSG_ placeholders", () => {
    expect(manifest.default_locale).toBe("en");
  });

  it("references the localized name and description via __MSG_ placeholders", () => {
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.description).toBe("__MSG_extensionDescription__");
  });

  it("exposes the i18n locale dictionaries to the Meet content script", () => {
    const meetResources = manifest.web_accessible_resources.find((entry) =>
      entry.matches.includes("https://meet.google.com/*")
    );
    expect(meetResources.resources).toEqual(
      expect.arrayContaining([
        "src/shared/i18n/locales/en.json",
        "src/shared/i18n/locales/es.json",
        "src/shared/i18n/locales/fr.json",
      ])
    );
  });
});
```

Note: the third test depends on Task 1's Step 2 already being done (it will fail if run before Task 1) — this is expected since Task 1 runs first in this plan.

Create `_locales/messages.test.js`:

```js
import { describe, expect, it } from "vitest";
import en from "./en/messages.json";
import es from "./es/messages.json";
import fr from "./fr/messages.json";

describe("_locales messages", () => {
  for (const [name, dict] of [["en", en], ["es", es], ["fr", fr]]) {
    it(`${name} defines extensionName and extensionDescription with non-empty message strings`, () => {
      expect(typeof dict.extensionName.message).toBe("string");
      expect(dict.extensionName.message.length).toBeGreaterThan(0);
      expect(typeof dict.extensionDescription.message).toBe("string");
      expect(dict.extensionDescription.message.length).toBeGreaterThan(0);
    });
  }

  it("all three locales define the same set of keys", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run manifest.test.js _locales/messages.test.js`
Expected: PASS (all tests green).

Run: `npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Manual verification (report what could and couldn't be checked)**

This needs a real Chrome instance, same as the parent plan's Task 5: load the extension unpacked via `chrome://extensions` → "Load unpacked", then:
1. With Chrome's language set to Spanish, check the extension's name/description on the `chrome://extensions` card — should read "Asterion — Captura de Reuniones" / the Spanish description.
2. Switch Chrome's language to English, reload the unpacked extension (`chrome://extensions` → reload icon), check again — should read "Asterion — Meeting Capture" / the English description.
3. Switch to French, repeat — should read "Asterion — Capture de Réunions" / the French description.
4. Switch to an unsupported language (e.g. Portuguese), repeat — should fall back to the English name/description (`default_locale`).

Report explicitly which of these were actually checked in a browser versus skipped.

- [ ] **Step 6: Commit**

```bash
git add _locales manifest.json manifest.test.js
git commit -m "feat: localize extension name and description via chrome.i18n"
```
