# Rebrand to Ariadne Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-specific override:** in this repo, tasks are delegated to and executed by the `codex:codex-rescue` agent (Codex), not by generic Claude subagents — see `CLAUDE.md`. Claude reviews each task's result against this plan before moving to the next one.

**Goal:** Rename the extension from "Asterion" to "Ariadne" everywhere a user (or a developer reading the code) would see the old name — extension name/description, the new icon (already generated), every UI surface (popup, settings, history, the on-page Meet banner), the three locale dictionaries, and the internal console log prefixes — without changing any behavior. This is a pure rebrand: no functional code changes, and this plan deliberately does **not** touch the internal `"asterion:*"` message-type string constants (the wire protocol between the content script, MAIN-world bootstrap, and background/offscreen documents) — see "Explicitly out of scope" below.

**Architecture:** No architecture changes. Every change in this plan is either a literal string replacement (brand name in HTML/JS/JSON) or a console log prefix change (`[Asterion...]` → `[Ariadne...]`). The new icon files (`icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png`, `icons/icon128.png`) were already regenerated from `icons/ariadne.png` (the 900×900 source the user provided) via `sips` and are ready to commit alongside this plan's changes — `manifest.json` already references these exact filenames, so no manifest change is needed for the icon swap itself.

**Tech Stack:** No new tooling — plain text edits across existing JS/HTML/JSON files.

**Context:** The user confirmed via `AskUserQuestion` before this plan was written: (1) this stays a personal-use rebrand, not a real Chrome Web Store publication — the PRD's "no distribution to third parties" scope decision (`asterion-alcance.md`, sections 4.2/6) is unaffected; (2) new name **"Ariadne — Meeting Recorder"**, new description **"Automatically record, transcribe, and save your meetings locally — no cloud, no subscriptions."** (deliberately platform-agnostic in tone, even though the product currently only supports Google Meet — matches how the user described wanting to position it); (3) internal console log prefixes and `package.json`'s name should be renamed too, for consistency, even though they're not user-visible.

**Explicitly out of scope (do not touch):**
- The `"asterion:*"` message-type string constants used as `postMessage`/`chrome.runtime.sendMessage` discriminators (e.g. `"asterion:start-session"`, `"asterion:mic-muted"`, `"asterion:chunk"`, etc., across `src/content/meet-detector.js`, `src/webrtc-bootstrap/bootstrap.js`, `src/offscreen/offscreen.js`, `src/background/service-worker.js`, `src/popup/popup.js`, `src/history/history.js`, `src/content/meet-banner.js`'s `data-asterion-enable-video` attribute, and others). These are internal protocol identifiers, not user-facing UI text — a regular user never sees them. (Codex's review flagged one nuance: a couple of debug `console.log` calls do print `message.type`, e.g. `src/content/meet-detector.js:104` and `src/webrtc-bootstrap/bootstrap.js:78/81`, so a developer with DevTools open *could* see the literal string `"asterion:start-session"` scroll by — that's still not the same as it being user-facing, and doesn't change the conclusion, just softens the claim that these strings are never visible anywhere.) Renaming them requires touching every sender **and** receiver consistently across many files for no real benefit, with a real risk (a single missed rename breaks a message handler silently). Not part of what was asked.
- `docs/superpowers/plans/*.md` (historical planning records — rewriting history serves no purpose) and `asterion-alcance.md` (the PRD — a living document, but renaming its content wasn't part of what was asked; flag to the user separately if they want that done too).
- The project's root directory name and git remote (still literally called `asterion` on disk) — not requested, and changing it would be disruptive for no functional reason.

---

## File Structure

- Modify: `manifest.json` — no path changes needed (already uses `__MSG_extensionName__`/`__MSG_extensionDescription__` and already points at `icons/icon{16,32,48,128}.png`, which are already regenerated with the new icon) — **this file needs no edits in this plan**, listed here only for completeness.
- Modify: `_locales/en/messages.json`, `_locales/es/messages.json`, `_locales/fr/messages.json` — the actual name/description strings Chrome resolves those placeholders to.
- Modify: `src/shared/i18n/locales/en.json`, `src/shared/i18n/locales/es.json`, `src/shared/i18n/locales/fr.json` — the three dictionary values that literally embed the brand name (`settings.pageTitle`, `history.pageTitle`, `banner.videoErrorLog`).
- Modify: `src/popup/popup.html`, `src/popup/popup.js`, `src/settings/settings.html`, `src/history/history.html`, `src/history/history.test.js`, `src/content/meet-banner.js` — literal brand text in markup/JS template strings.
- Modify: `CLAUDE.md` — the project-instructions doc's title (developer-facing, not shown to end users, but still says the old name — caught by Codex's review of this plan).
- Modify: `package.json` — the `name` field.
- Modify: `package-lock.json` — regenerated automatically by `npm install` after `package.json`'s name changes (see Task 2), not hand-edited.
- Modify: `src/background/service-worker.js`, `src/offscreen/offscreen.js`, `src/offscreen/ffmpeg-client.js`, `src/content/meet-caption-observer.js`, `src/content/meet-detector.js`, `src/storage/session-writer.js`, `src/webrtc-bootstrap/bootstrap.js` — console log prefixes (`[Asterion...]` → `[Ariadne...]`).

---

### Task 1: Rebrand user-facing text (manifest i18n, in-app UI dictionaries, HTML, popup/banner JS)

**Files:**
- Modify: `_locales/en/messages.json`
- Modify: `_locales/es/messages.json`
- Modify: `_locales/fr/messages.json`
- Modify: `src/shared/i18n/locales/en.json`
- Modify: `src/shared/i18n/locales/es.json`
- Modify: `src/shared/i18n/locales/fr.json`
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.js`
- Modify: `src/settings/settings.html`
- Modify: `src/history/history.html`
- Modify: `src/history/history.test.js`
- Modify: `src/content/meet-banner.js`

- [ ] **Step 1: Update the Chrome Web Store name/description strings**

In `_locales/en/messages.json`, change:

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

to:

```json
{
  "extensionName": {
    "message": "Ariadne — Meeting Recorder",
    "description": "Extension name shown in the Chrome Web Store and chrome://extensions."
  },
  "extensionDescription": {
    "message": "Automatically record, transcribe, and save your meetings locally — no cloud, no subscriptions.",
    "description": "Extension description shown in the Chrome Web Store and chrome://extensions."
  }
}
```

In `_locales/es/messages.json`, change:

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

to:

```json
{
  "extensionName": {
    "message": "Ariadne — Grabador de Reuniones",
    "description": "Nombre de la extensión mostrado en la Chrome Web Store y en chrome://extensions."
  },
  "extensionDescription": {
    "message": "Graba, transcribe y guarda tus reuniones de forma local y automática — sin nube, sin suscripciones.",
    "description": "Descripción de la extensión mostrada en la Chrome Web Store y en chrome://extensions."
  }
}
```

In `_locales/fr/messages.json`, change:

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

to:

```json
{
  "extensionName": {
    "message": "Ariadne — Enregistreur de Réunions",
    "description": "Nom de l'extension affiché dans le Chrome Web Store et sur chrome://extensions."
  },
  "extensionDescription": {
    "message": "Enregistrez, transcrivez et sauvegardez vos réunions localement et automatiquement — sans cloud, sans abonnement.",
    "description": "Description de l'extension affichée dans le Chrome Web Store et sur chrome://extensions."
  }
}
```

- [ ] **Step 2: Update the in-app i18n dictionaries**

In `src/shared/i18n/locales/en.json`, change these three values (leave every other key untouched):
- `"settings.pageTitle": "Asterion — Settings"` → `"settings.pageTitle": "Ariadne — Settings"`
- `"history.pageTitle": "Asterion — History"` → `"history.pageTitle": "Ariadne — History"`
- `"banner.videoErrorLog": "[Asterion] Could not enable video:"` → `"banner.videoErrorLog": "[Ariadne] Could not enable video:"`

In `src/shared/i18n/locales/es.json`, change:
- `"settings.pageTitle": "Asterion — Configuración"` → `"settings.pageTitle": "Ariadne — Configuración"`
- `"history.pageTitle": "Asterion — Historial"` → `"history.pageTitle": "Ariadne — Historial"`
- `"banner.videoErrorLog": "[Asterion] No se pudo activar video:"` → `"banner.videoErrorLog": "[Ariadne] No se pudo activar video:"`

In `src/shared/i18n/locales/fr.json`, change:
- `"settings.pageTitle": "Asterion — Paramètres"` → `"settings.pageTitle": "Ariadne — Paramètres"`
- `"history.pageTitle": "Asterion — Historique"` → `"history.pageTitle": "Ariadne — Historique"`
- `"banner.videoErrorLog": "[Asterion] Impossible d'activer la vidéo :"` → `"banner.videoErrorLog": "[Ariadne] Impossible d'activer la vidéo :"`

- [ ] **Step 3: Update static HTML fallback text**

In `src/popup/popup.html`, change:

```html
    <title>Asterion</title>
```

to:

```html
    <title>Ariadne</title>
```

In `src/settings/settings.html`, change:

```html
    <title>Asterion — Configuración</title>
```

to:

```html
    <title>Ariadne — Configuración</title>
```

In `src/history/history.html`, change:

```html
    <title>Asterion — Historial</title>
```

to:

```html
    <title>Ariadne — Historial</title>
```

and change:

```html
        <div class="brand"><img src="../../icons/icon32.png" alt="" /><span>Asterion</span></div>
```

to:

```html
        <div class="brand"><img src="../../icons/icon32.png" alt="" /><span>Ariadne</span></div>
```

- [ ] **Step 4: Update the popup's brand text**

In `src/popup/popup.js`, change:

```js
    <div class="brand"><img src="${chrome.runtime.getURL("icons/icon32.png")}" width="18" height="18" alt="">Asterion</div>
```

to:

```js
    <div class="brand"><img src="${chrome.runtime.getURL("icons/icon32.png")}" width="18" height="18" alt="">Ariadne</div>
```

- [ ] **Step 5: Update the on-page Meet banner's brand text and error log**

In `src/content/meet-banner.js`, change (two separate occurrences of the exact same `<strong>Asterion</strong>` substring — both need to change):

```js
    <div class="brand-copy"><strong>Asterion</strong><span>${t("popup.statusDetected")}</span></div>
```

to:

```js
    <div class="brand-copy"><strong>Ariadne</strong><span>${t("popup.statusDetected")}</span></div>
```

and change:

```js
      <div class="recording-copy"><img class="brand-icon" src="${chrome.runtime.getURL("icons/icon32.png")}" alt="" width="20" height="20"><strong>Asterion</strong><span class="timer">${formatElapsed(currentMeta.startedAt)}</span></div>
```

to:

```js
      <div class="recording-copy"><img class="brand-icon" src="${chrome.runtime.getURL("icons/icon32.png")}" alt="" width="20" height="20"><strong>Ariadne</strong><span class="timer">${formatElapsed(currentMeta.startedAt)}</span></div>
```

and change the console log prefix on the same file:

```js
    console.error("[Asterion] i18n initialization failed for the Meet banner", error);
```

to:

```js
    console.error("[Ariadne] i18n initialization failed for the Meet banner", error);
```

- [ ] **Step 6: Update the test fixture that mirrors history.html's markup**

In `src/history/history.test.js`, change:

```js
    <div class="brand"><img alt="" /><span>Asterion</span></div>
```

to:

```js
    <div class="brand"><img alt="" /><span>Ariadne</span></div>
```

(This fixture's text isn't directly asserted by any test in this file, but it should still mirror the real markup for anyone reading the test later.)

- [ ] **Step 7: Update CLAUDE.md's title**

Codex's review of this plan caught that `CLAUDE.md` (the project instructions file — developer-facing, not shown to an end user, but a document a developer/agent working on this repo reads directly) still says the old name in its title and was missed by the first version of this plan. In `CLAUDE.md`, change:

```markdown
# Reglas del proyecto Asterion
```

to:

```markdown
# Reglas del proyecto Ariadne
```

Only the title — leave the rest of `CLAUDE.md`'s content (the Claude/Codex workflow rules) untouched; this step is a name change, not a content review.

- [ ] **Step 8: Run the full test suite and the build**

Run: `npm test`
Expected: PASS, all suites green (this task only changes string literals, not logic, so no test assertions should need to change; `manifest.test.js` and `_locales/messages.test.js` check structure and non-empty strings, not the exact brand text, so they're unaffected).

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 9: Verify no stray "Asterion" remains in the files this task touched**

Run:
```bash
grep -n "Asterion" _locales/en/messages.json _locales/es/messages.json _locales/fr/messages.json src/shared/i18n/locales/en.json src/shared/i18n/locales/es.json src/shared/i18n/locales/fr.json src/popup/popup.html src/popup/popup.js src/settings/settings.html src/history/history.html src/history/history.test.js src/content/meet-banner.js CLAUDE.md
```
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add _locales src/shared/i18n/locales src/popup/popup.html src/popup/popup.js src/settings/settings.html src/history/history.html src/history/history.test.js src/content/meet-banner.js CLAUDE.md
git commit -m "feat: rebrand to Ariadne — user-facing text, i18n dictionaries, and store listing"
```

---

### Task 2: Rebrand internal console log prefixes and package.json

**Files:**
- Modify: `package.json`
- Modify: `src/background/service-worker.js`
- Modify: `src/offscreen/offscreen.js`
- Modify: `src/offscreen/ffmpeg-client.js`
- Modify: `src/content/meet-caption-observer.js`
- Modify: `src/content/meet-detector.js`
- Modify: `src/storage/session-writer.js`
- Modify: `src/webrtc-bootstrap/bootstrap.js`

None of these are visible to an end user — they're `console.log`/`console.debug`/`console.error` prefixes only a developer with DevTools open would see. Renamed anyway per the user's explicit choice, for consistency across the codebase.

- [ ] **Step 1: Update package.json, then regenerate package-lock.json**

Change:

```json
  "name": "asterion",
```

to:

```json
  "name": "ariadne",
```

`package-lock.json` also has `"name": "asterion"` in two places (the root `name` field and the `packages[""].name` entry — this is npm's own lockfile metadata, not something this plan's other file-content changes touch). Codex's review caught that the first version of this plan only renamed `package.json` and left the lockfile inconsistent. Don't hand-edit `package-lock.json` — regenerate it the normal way so npm keeps every other field (dependency tree, integrity hashes) correct:

Run: `npm install`
Expected: completes without errors; `git diff package-lock.json` afterward should show only the two `"name"` fields changing from `"asterion"` to `"ariadne"` (no dependency/version changes, since nothing in `package.json`'s `dependencies`/`devDependencies` changed).

- [ ] **Step 2: Update every `[Asterion...]` console log prefix**

Every occurrence below is a simple `[Asterion` → `[Ariadne` substring replacement (the rest of each line — the message text after the prefix, any interpolated variables — is unchanged). Replace all of them, exactly as listed:

In `src/background/service-worker.js`:
- Line 82: `console.error("[Asterion] No se pudo leer el preset de video guardado, se usa 'medium' por defecto:", error);` → `console.error("[Ariadne] No se pudo leer el preset de video guardado, se usa 'medium' por defecto:", error);`

In `src/offscreen/offscreen.js`:
- Line 13: `console.error("[Asterion] No se pudo iniciar el storage de la sesión:", error);` → `console.error("[Ariadne] No se pudo iniciar el storage de la sesión:", error);`
- Line 18: `console.error("[Asterion] Error escribiendo chunk:", error);` → `console.error("[Ariadne] Error escribiendo chunk:", error);`
- Line 32: `console.error("[Asterion] Error finalizando la sesión:", error);` → `console.error("[Ariadne] Error finalizando la sesión:", error);`

In `src/offscreen/ffmpeg-client.js`:
- Line 12: `` console.log(`[Asterion ffmpeg:core] ${type}: ${message}`); `` → `` console.log(`[Ariadne ffmpeg:core] ${type}: ${message}`); ``
- Line 15: `` console.log(`[Asterion ffmpeg:core] progress=${progress} time=${time}`); `` → `` console.log(`[Ariadne ffmpeg:core] progress=${progress} time=${time}`); ``
- Line 46: `` console.log(`[Asterion ffmpeg] job ${jobId}: iniciando (${inputBytes.byteLength} bytes de entrada)`); `` → `` console.log(`[Ariadne ffmpeg] job ${jobId}: iniciando (${inputBytes.byteLength} bytes de entrada)`); ``
- Line 60: `` `[Asterion ffmpeg] job ${jobId}: terminado en ${Date.now() - startedAt}ms (${outputData.byteLength} bytes de salida)` `` → `` `[Ariadne ffmpeg] job ${jobId}: terminado en ${Date.now() - startedAt}ms (${outputData.byteLength} bytes de salida)` ``

In `src/content/meet-caption-observer.js`:
- Line 6: `console.log("[Asterion:debug] findCaptionsContainer — regiones encontradas:", regions.length);` → `console.log("[Ariadne:debug] findCaptionsContainer — regiones encontradas:", regions.length);`
- Line 9: `console.log("[Asterion:debug] findCaptionsContainer — región:", {` → `console.log("[Ariadne:debug] findCaptionsContainer — región:", {`
- Line 22: `console.log("[Asterion:debug] findCaptionsContainer — ninguna región tenía captionUtteranceBlock");` → `console.log("[Ariadne:debug] findCaptionsContainer — ninguna región tenía captionUtteranceBlock");`
- Line 57: `console.log("[Asterion:debug] isCaptionsCurrentlyOn — íconos encontrados en el botón:", icons);` → `console.log("[Ariadne:debug] isCaptionsCurrentlyOn — íconos encontrados en el botón:", icons);`
- Line 60: `console.log("[Asterion:debug] isCaptionsCurrentlyOn — resultado:", result);` → `console.log("[Ariadne:debug] isCaptionsCurrentlyOn — resultado:", result);`
- Line 71: `console.log("[Asterion:debug] ensureCaptionsEnabled — botón encontrado, alreadyOn:", alreadyOn);` → `console.log("[Ariadne:debug] ensureCaptionsEnabled — botón encontrado, alreadyOn:", alreadyOn);`
- Line 74: `console.log("[Asterion:debug] ensureCaptionsEnabled — click ejecutado");` → `console.log("[Ariadne:debug] ensureCaptionsEnabled — click ejecutado");`

In `src/content/meet-detector.js`:
- Line 8: `console.log("[Asterion:debug] content script (ISOLATED) cargado", { url: location.href });` → `console.log("[Ariadne:debug] content script (ISOLATED) cargado", { url: location.href });`
- Line 60: `console.log("[Asterion:debug] startRecording iniciado", { sessionId, meetingTitle });` → `console.log("[Ariadne:debug] startRecording iniciado", { sessionId, meetingTitle });`
- Line 104: `console.log("[Asterion:debug] mensaje recibido desde MAIN world", { type: message.type });` → `console.log("[Ariadne:debug] mensaje recibido desde MAIN world", { type: message.type });`
- Line 112: `console.error("[Asterion] No se pudo iniciar la sesión:", message.reason);` → `console.error("[Ariadne] No se pudo iniciar la sesión:", message.reason);`
- Line 179: `console.log("[Asterion:debug] waitForMeeting isInActiveMeeting", { isInActiveMeeting: isInActiveMeeting() });` → `console.log("[Ariadne:debug] waitForMeeting isInActiveMeeting", { isInActiveMeeting: isInActiveMeeting() });`
- Line 182: `console.log("[Asterion:debug] reunión detectada");` → `console.log("[Ariadne:debug] reunión detectada");`
- Line 184: `console.log("[Asterion:debug] autoStart obtenido", { autoStart });` → `console.log("[Ariadne:debug] autoStart obtenido", { autoStart });`

In `src/storage/session-writer.js`:
- Line 206: `console.error("[Asterion] Falló la conversión de audio a MP3 (el webm original queda intacto):", error);` → `console.error("[Ariadne] Falló la conversión de audio a MP3 (el webm original queda intacto):", error);`
- Line 218: `console.error("[Asterion] No se pudo obtener el preset de video guardado, se usa 'medium' por defecto:", error);` → `console.error("[Ariadne] No se pudo obtener el preset de video guardado, se usa 'medium' por defecto:", error);`
- Line 238: `console.error("[Asterion] Falló la conversión de video a MP4 (el webm original queda intacto):", error);` → `console.error("[Ariadne] Falló la conversión de video a MP4 (el webm original queda intacto):", error);`
- Line 244: `console.error("[Asterion] Falló inesperadamente la programación de conversiones:", error);` → `console.error("[Ariadne] Falló inesperadamente la programación de conversiones:", error);`
- Line 250: `console.error("[Asterion] Falló el callback de finalización de conversiones:", error);` → `console.error("[Ariadne] Falló el callback de finalización de conversiones:", error);`

In `src/webrtc-bootstrap/bootstrap.js`:
- Line 12: `` const rtcPatchLog = (event, details) => console.debug(`[Asterion:rtc-patch] ${event}`, details); `` → `` const rtcPatchLog = (event, details) => console.debug(`[Ariadne:rtc-patch] ${event}`, details); ``
- Line 14: `console.log("[Asterion:debug] bootstrap (MAIN world) cargado");` → `console.log("[Ariadne:debug] bootstrap (MAIN world) cargado");`
- Line 17: `` log: (event, details) => console.debug(`[Asterion:audio-mixer] ${event}`, details), `` → `` log: (event, details) => console.debug(`[Ariadne:audio-mixer] ${event}`, details), ``
- Line 78: `console.log("[Asterion:debug] mensaje recibido desde ISOLATED world", { type: message.type });` → `console.log("[Ariadne:debug] mensaje recibido desde ISOLATED world", { type: message.type });`
- Line 81: `console.log("[Asterion:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {` → `console.log("[Ariadne:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {` (note: only the `[Asterion:debug]` prefix changes here — the `asterion:start-session` text later in the same string is the literal message-type constant, explicitly out of scope per this plan's header; leave that part alone)
- Line 104: `console.log("[Asterion] AudioContext state antes de resume():", mixer.audioContext.state);` → `console.log("[Ariadne] AudioContext state antes de resume():", mixer.audioContext.state);`
- Line 106: `console.log("[Asterion] AudioContext state después de resume():", mixer.audioContext.state);` → `console.log("[Ariadne] AudioContext state después de resume():", mixer.audioContext.state);`
- Line 135: `console.log("[Asterion] userActivation.isActive antes de getDisplayMedia:", navigator.userActivation?.isActive);` → `console.log("[Ariadne] userActivation.isActive antes de getDisplayMedia:", navigator.userActivation?.isActive);`

- [ ] **Step 3: Run the full test suite and the build**

Run: `npm test`
Expected: PASS, all suites green (none of these files have tests asserting the exact log prefix text).

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Verify no stray "Asterion" remains in the files this task touched, and that the message-type constants are untouched**

Run:
```bash
grep -n '"name": "asterion"' package.json package-lock.json
```
Expected: no output (confirms both the manifest-adjacent `package.json` and the regenerated `package-lock.json` now say `"ariadne"`).

Run:
```bash
grep -n "Asterion" package.json src/background/service-worker.js src/offscreen/offscreen.js src/offscreen/ffmpeg-client.js src/content/meet-caption-observer.js src/content/meet-detector.js src/storage/session-writer.js src/webrtc-bootstrap/bootstrap.js
```
Expected: no output.

Run:
```bash
grep -c '"asterion:' src/content/meet-detector.js src/webrtc-bootstrap/bootstrap.js
```
Expected: non-zero counts in both (confirms the `"asterion:*"` message-type constants are still present and untouched, as intended — this plan explicitly does not rename them).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/background/service-worker.js src/offscreen/offscreen.js src/offscreen/ffmpeg-client.js src/content/meet-caption-observer.js src/content/meet-detector.js src/storage/session-writer.js src/webrtc-bootstrap/bootstrap.js
git commit -m "chore: rebrand internal console log prefixes and package name to Ariadne"
```

---

### Task 3: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Repo-wide sanity grep**

Run:
```bash
grep -rn "Asterion" --include="*.js" --include="*.html" --include="*.json" . | grep -v node_modules | grep -v "^\./docs/superpowers/plans/" | grep -v "^\./asterion-alcance.md"
```
Expected: no output (everything outside the deliberately-excluded historical plan docs and the PRD is now rebranded).

- [ ] **Step 4: Manual verification (report what could and couldn't be checked)**

This needs the extension actually loaded in Chrome — report explicitly which of these were checked versus skipped:
1. Load the unpacked extension (`chrome://extensions` → reload) and confirm the new Ariadne icon shows up in the toolbar and on the `chrome://extensions` card, along with the new name/description.
2. Open the popup and confirm it shows "Ariadne" as the brand text, not "Asterion".
3. Open Settings and History from the popup and confirm their page titles/brand text say "Ariadne".
4. Join (or simulate) a Meet call and confirm the on-page banner shows "Ariadne" instead of "Asterion".

- [ ] **Step 5: Commit** (only if step 4 uncovers something that needs a follow-up fix; otherwise this task produces no code changes to commit)
