# i18n for popup, settings and history pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-specific override:** in this repo, tasks are delegated to and executed by the `codex:codex-rescue` agent (Codex), not by generic Claude subagents — see `CLAUDE.md`. Claude reviews each task's result against this plan before moving to the next one.

**Goal:** Let Asterion's UI (popup, settings, history pages) render in Spanish, English or French, auto-detected from the browser's language, with English as the ultimate fallback — no user-facing language picker.

**Architecture:** A small dependency-free i18n module (`src/shared/i18n/i18n.js`) detects the browser's language, loads a matching JSON dictionary (`src/shared/i18n/locales/{en,es,fr}.json`), and merges it over the English dictionary so any missing key still resolves to English instead of being blank. Each page (`settings.js`, `popup.js`, `history.js`) calls `initI18n()` once at startup and uses the returned `t(key, params)` function everywhere it currently has a hardcoded Spanish string. `chrome.i18n`/`_locales` is deliberately not used, because it follows the browser's own locale mechanism and can't be swapped at the page level the way this custom loader can.

**Tech Stack:** Vanilla JS (ES modules, no bundler for these 3 pages — matches the existing pattern of `../shared/icons.js`), `fetch` + `chrome.runtime.getURL` to load packaged JSON, Vitest for unit tests (existing `jsdom` environment).

**Out of scope (explicitly deferred):** the on-page recording banner injected into Google Meet (`src/content/meet-banner.js`) also has hardcoded Spanish text, but it runs as a content script and would need its resources added to `web_accessible_resources` — that's tracked separately and is not part of this plan. Extension metadata in `manifest.json` (`name`, `description` — the Chrome Web Store listing) is also out of scope; that uses a different mechanism (`chrome.i18n` + `default_locale`) and wasn't requested.

**Codex review:** this plan was reviewed by Codex before execution (per this project's CLAUDE.md). Codex confirmed the architecture is sound — no `web_accessible_resources` change is needed for popup/settings/history since they're extension-origin pages (unlike the Meet-scoped content scripts), and replacing the hardcoded `"es-ES"` `Intl` locale with `localeTag` is safe because `localeTag` only ever comes from the fixed internal map. Codex also found real issues, all incorporated below: `initI18n` had no fetch-failure handling (a corrupted/missing JSON would brick page startup); `initI18n`/`fetchDictionary` *can* be unit-tested under `vitest`'s `jsdom` environment by mocking `chrome.runtime.getURL`/`fetch` (the plan originally claimed otherwise — that was wrong); `history.weekdays` as a raw array value made `t()` a mixed-type API unnecessarily, since `Intl.DateTimeFormat` can generate weekday names directly; the French `popup.micMutedLabel` had a grammatical-agreement bug ("Coupé" instead of "Coupée", since it modifies the feminine "Ma voix"); `settings.js`'s original `.then()`-based init was inconsistent with the other two pages' top-level `await` and had no failure handling; and Task 4's original full-file-replacement framing for `history.js` carried real transcription risk given the file's size, and incorrectly claimed pre-existing tests cover `deriveVisibleMeetings` (they don't — it's only used internally in `history.js`).

---

## File Structure

- Create: `src/shared/i18n/locales/en.json` — English dictionary (source of truth / fallback).
- Create: `src/shared/i18n/locales/es.json` — Spanish dictionary.
- Create: `src/shared/i18n/locales/fr.json` — French dictionary.
- Create: `src/shared/i18n/i18n.js` — `detectLocale`, `mergeWithFallback`, `interpolate`, `makeTranslator` (pure, unit-tested), and `initI18n` (loads dictionaries via `fetch`/`chrome.runtime.getURL`, sets `document.documentElement.lang`).
- Create: `src/shared/i18n/i18n.test.js` — Vitest unit tests for the pure functions.
- Modify: `src/settings/settings.html` — add `id`s to the elements whose text needs to be swapped at runtime.
- Modify: `src/settings/settings.js` — call `initI18n()` and translate the page.
- Modify: `src/popup/popup.js` — call `initI18n()` and replace every hardcoded string with `t(...)`.
- Modify: `src/history/history.html` — add `id`s to the two sidebar text elements.
- Modify: `src/history/history.js` — call `initI18n()`, replace every hardcoded string with `t(...)`, and replace the hardcoded `"es-ES"` `Intl` locale with the detected `localeTag`.

## Complete key → text mapping

This table is the single source of truth for every dictionary key used below (also embedded directly in the JSON files in Task 1). Namespaces: `common.*` (shared across pages), `settings.*`, `popup.*`, `history.*`.

| Key | es (original) | en | fr |
|---|---|---|---|
| common.untitledMeeting | Reunión sin título | Untitled meeting | Réunion sans titre |
| common.transcript | Transcripción | Transcript | Transcription |
| common.audio | Audio | Audio | Audio |
| common.video | Video | Video | Vidéo |
| common.manifest | Manifest | Manifest | Manifest |
| common.play | Reproducir | Play | Lire |
| common.pause | Pausar | Pause | Pause |
| common.download | Descargar | Download | Télécharger |
| common.open | Abrir | Open | Ouvrir |
| common.cancel | Cancelar | Cancel | Annuler |
| common.delete | Eliminar | Delete | Supprimer |
| common.deleteMeeting | Eliminar reunión | Delete meeting | Supprimer la réunion |
| common.volumeAria | Volumen | Volume | Volume |
| common.meetingAudioLabel | Audio de la reunión | Meeting audio | Audio de la réunion |
| settings.pageTitle | Asterion — Configuración | Asterion — Settings | Asterion — Paramètres |
| settings.backAria | Volver | Back | Retour |
| settings.title | Configuración | Settings | Paramètres |
| settings.videoPresetLabel | Velocidad y calidad del video | Video speed and quality | Vitesse et qualité vidéo |
| settings.videoPresetHelper | Más rápido = menos calidad/compresión, más lento = mejor compresión. | Faster = less quality/compression, slower = better compression. | Plus rapide = moins de qualité/compression, plus lent = meilleure compression. |
| popup.settingsAria | Configuración | Settings | Paramètres |
| popup.autoDetectLabel | Detectar reuniones en Meet | Detect meetings in Meet | Détecter les réunions dans Meet |
| popup.autoDetectHelper | Inicia la captura sola al entrar a una llamada de Meet. Esto aplica a cualquier reunión, no solo a la actual. | Starts capture automatically when you join a Meet call. This applies to any meeting, not just the current one. | Démarre la capture automatiquement en rejoignant un appel Meet. Cela s'applique à toute réunion, pas seulement à l'actuelle. |
| popup.historyLink | Ver historial | View history | Voir l'historique |
| popup.statusReady | Listo | Ready | Prêt |
| popup.statusReadyCopy | Abre una reunión de Google Meet para comenzar. | Open a Google Meet meeting to get started. | Ouvrez une réunion Google Meet pour commencer. |
| popup.statusDetected | Reunión detectada | Meeting detected | Réunion détectée |
| popup.startCapture | Iniciar captura | Start capture | Démarrer la capture |
| popup.statusError | Error | Error | Erreur |
| popup.statusErrorCopy | No se pudo iniciar la grabación. Volvé a intentarlo. | Recording could not be started. Please try again. | Impossible de démarrer l'enregistrement. Veuillez réessayer. |
| popup.statusRecording | Grabando | Recording | Enregistrement |
| popup.stopCapture | Detener captura | Stop capture | Arrêter la capture |
| popup.tabVideoLabel | Video de la pestaña | Tab video | Vidéo de l'onglet |
| popup.micLabel | Mi voz | My voice | Ma voix |
| popup.activeFem | Activa | Active | Active |
| popup.activeMasc | Activo | Active | Actif |
| popup.notActive | No activo | Not active | Non actif |
| common.notAvailable | No disponible | Not available | Non disponible |
| popup.micMutedLabel | Silenciada | Muted | Coupée |
| popup.processingMultiple | Procesando {{count}} reuniones... | Processing {{count}} meetings... | Traitement de {{count}} réunions... |
| popup.processingSingle | Procesando {{label}}... {{pct}}% | Processing {{label}}... {{pct}}% | Traitement de {{label}}... {{pct}}% |
| popup.processingLabelVideo | video | video | vidéo |
| popup.processingLabelAudio | audio | audio | audio |
| history.pageTitle | Asterion — Historial | Asterion — History | Asterion — Historique |
| history.pageHeading | Historial | History | Historique |
| history.pageDescription | Reuniones guardadas localmente en este dispositivo. | Meetings saved locally on this device. | Réunions enregistrées localement sur cet appareil. |
| history.filtersAsideAria | Filtros del historial | History filters | Filtres de l'historique |
| history.searchPlaceholder | Buscar por título | Search by title | Rechercher par titre |
| history.filtersLabel | Filtros | Filters | Filtres |
| history.calendarAria | Calendario | Calendar | Calendrier |
| history.summaryLabel | Resumen | Summary | Résumé |
| history.meetingsTitle | Reuniones | Meetings | Réunions |
| history.sortAria | Ordenar reuniones | Sort meetings | Trier les réunions |
| history.sortNewest | Más recientes primero | Newest first | Plus récentes d'abord |
| history.sortOldest | Más antiguas primero | Oldest first | Plus anciennes d'abord |
| history.detailPanelAria | Detalle de reunión | Meeting detail | Détail de la réunion |
| history.filterAll | Todas | All | Toutes |
| history.filterTranscript | Con transcripción | With transcript | Avec transcription |
| history.filterVideo | Con video | With video | Avec vidéo |
| history.filterAudioOnly | Solo audio | Audio only | Audio seulement |
| history.filterThisMonth | Este mes | This month | Ce mois-ci |
| history.filterThisYear | Este año | This year | Cette année |
| history.prevMonthAria | Mes anterior | Previous month | Mois précédent |
| history.nextMonthAria | Mes siguiente | Next month | Mois suivant |
| history.kpiMeetingsThisMonth | reuniones este mes | meetings this month | réunions ce mois-ci |
| history.kpiRecordingHours | de grabación | recorded | d'enregistrement |
| history.kpiMeetingsWithVideo | reuniones con video | meetings with video | réunions avec vidéo |
| history.kpiMeetingsWithTranscript | reuniones con transcripción | meetings with transcript | réunions avec transcription |
| history.resultsCount | {{count}} resultados | {{count}} results | {{count}} résultats |
| history.emptyState | Todavía no hay reuniones que coincidan con estos filtros. | No meetings match these filters yet. | Aucune réunion ne correspond encore à ces filtres. |
| history.moreOptionsAria | Más opciones | More options | Plus d'options |
| history.viewDetails | Ver detalles | View details | Voir les détails |
| history.seekAria | Posición de reproducción | Playback position | Position de lecture |
| history.mediaLoadError | No se pudo cargar este archivo multimedia. | This media file could not be loaded. | Ce fichier multimédia n'a pas pu être chargé. |
| history.fullscreenAria | Pantalla completa | Fullscreen | Plein écran |
| history.playVideoAria | Reproducir video | Play video | Lire la vidéo |
| history.rewind10Aria | Retroceder 10 segundos | Rewind 10 seconds | Reculer de 10 secondes |
| history.forward10Aria | Adelantar 10 segundos | Forward 10 seconds | Avancer de 10 secondes |
| history.noTranscriptSegments | No se encontraron intervenciones en la transcripción. | No segments were found in the transcript. | Aucun segment n'a été trouvé dans la transcription. |
| history.selectMeetingPlaceholder | Seleccioná una reunión para ver el detalle | Select a meeting to see the detail | Sélectionnez une réunion pour voir le détail |
| history.loadingFile | Cargando archivo... | Loading file... | Chargement du fichier... |
| history.fileOpenError | No se pudo abrir este archivo de la reunión. | This meeting file could not be opened. | Ce fichier de réunion n'a pas pu être ouvert. |
| history.downloadTxt | Descargar TXT | Download TXT | Télécharger TXT |
| history.downloadMarkdown | Descargar Markdown | Download Markdown | Télécharger Markdown |
| history.deleteConfirmBody | Se eliminarán {{title}} y todos sus archivos de este dispositivo. Esta acción es permanente y no se puede deshacer. | {{title}} and all its files will be deleted from this device. This action is permanent and cannot be undone. | {{title}} et tous ses fichiers seront supprimés de cet appareil. Cette action est permanente et irréversible. |

Notes:
- `"Google Meet"`, `"Asterion"` and file names (`manifest.json`, `.mp3`, `.webm`, etc.) are proper nouns / technical strings and are **not** translated — they stay as literals in the code.
- The video preset option values in `settings.html` (`ultrafast`, `superfast`, ... `veryslow`) are ffmpeg preset names, not translated.
- `common.activeFem`/`common.activeMasc` are split instead of a single `common.active` key because the original Spanish text uses grammatical gender ("Transcripción **activa**" vs. "Video **activo**"); English/French don't need the distinction but keeping two keys avoids re-deriving gender agreement logic.
- Calendar weekday abbreviations (`"Lu, Ma, Mi..."` etc.) are **not** stored as a dictionary array. They're generated at runtime with `Intl.DateTimeFormat(localeTag, { weekday: "short" })`, one call per day of a fixed reference week — see Task 4. This keeps `t()` a pure string-in/string-out function instead of a mixed-type API, and reuses the same `Intl` machinery already used for date formatting elsewhere in `history.js`.

---

### Task 1: i18n core module, dictionaries, and unit tests

**Files:**
- Create: `src/shared/i18n/locales/en.json`
- Create: `src/shared/i18n/locales/es.json`
- Create: `src/shared/i18n/locales/fr.json`
- Create: `src/shared/i18n/i18n.js`
- Test: `src/shared/i18n/i18n.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/shared/i18n/i18n.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  interpolate,
  makeTranslator,
  mergeWithFallback,
} from "./i18n.js";

describe("detectLocale", () => {
  it("matches an exact supported language code", () => {
    expect(detectLocale("es")).toBe("es");
    expect(detectLocale("fr")).toBe("fr");
    expect(detectLocale("en")).toBe("en");
  });

  it("matches the base language from a region-qualified tag", () => {
    expect(detectLocale("es-ES")).toBe("es");
    expect(detectLocale("es-419")).toBe("es");
    expect(detectLocale("fr-CA")).toBe("fr");
    expect(detectLocale("en-GB")).toBe("en");
  });

  it("falls back to English when the language isn't supported", () => {
    expect(detectLocale("pt-BR")).toBe("en");
    expect(detectLocale("de")).toBe("en");
  });

  it("falls back to English when no language is given", () => {
    expect(detectLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(detectLocale("")).toBe(DEFAULT_LOCALE);
  });

  it("is case-insensitive", () => {
    expect(detectLocale("ES-es")).toBe("es");
  });
});

describe("mergeWithFallback", () => {
  it("keeps the target's value when a key exists in both", () => {
    expect(mergeWithFallback({ a: "target" }, { a: "fallback" })).toEqual({ a: "target" });
  });

  it("uses the fallback's value when the key is missing from the target", () => {
    expect(mergeWithFallback({ a: "target" }, { a: "fallback", b: "fallback-only" })).toEqual({
      a: "target",
      b: "fallback-only",
    });
  });
});

describe("interpolate", () => {
  it("replaces {{name}} placeholders with params", () => {
    expect(interpolate("Hola {{name}}", { name: "Ana" })).toBe("Hola Ana");
  });

  it("leaves unmatched placeholders untouched", () => {
    expect(interpolate("Hola {{name}}", {})).toBe("Hola {{name}}");
  });

  it("returns non-string values unchanged", () => {
    const value = ["Lu", "Ma"];
    expect(interpolate(value, { name: "Ana" })).toBe(value);
  });
});

describe("makeTranslator", () => {
  it("returns the dictionary value for a known key", () => {
    const t = makeTranslator({ "common.play": "Reproducir" });
    expect(t("common.play")).toBe("Reproducir");
  });

  it("interpolates params into the dictionary value", () => {
    const t = makeTranslator({ "popup.processingMultiple": "Procesando {{count}} reuniones..." });
    expect(t("popup.processingMultiple", { count: 3 })).toBe("Procesando 3 reuniones...");
  });

  it("falls back to the key itself when missing from the dictionary", () => {
    const t = makeTranslator({});
    expect(t("missing.key")).toBe("missing.key");
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("includes es, en and fr", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "es", "fr"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/i18n/i18n.test.js`
Expected: FAIL — `src/shared/i18n/i18n.js` does not exist yet (`Failed to resolve import`).

- [ ] **Step 3: Create the English dictionary (fallback / source of truth)**

Create `src/shared/i18n/locales/en.json`:

```json
{
  "common.untitledMeeting": "Untitled meeting",
  "common.transcript": "Transcript",
  "common.audio": "Audio",
  "common.video": "Video",
  "common.manifest": "Manifest",
  "common.play": "Play",
  "common.pause": "Pause",
  "common.download": "Download",
  "common.open": "Open",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.deleteMeeting": "Delete meeting",
  "common.volumeAria": "Volume",
  "common.meetingAudioLabel": "Meeting audio",
  "common.notAvailable": "Not available",
  "settings.pageTitle": "Asterion — Settings",
  "settings.backAria": "Back",
  "settings.title": "Settings",
  "settings.videoPresetLabel": "Video speed and quality",
  "settings.videoPresetHelper": "Faster = less quality/compression, slower = better compression.",
  "popup.settingsAria": "Settings",
  "popup.autoDetectLabel": "Detect meetings in Meet",
  "popup.autoDetectHelper": "Starts capture automatically when you join a Meet call. This applies to any meeting, not just the current one.",
  "popup.historyLink": "View history",
  "popup.statusReady": "Ready",
  "popup.statusReadyCopy": "Open a Google Meet meeting to get started.",
  "popup.statusDetected": "Meeting detected",
  "popup.startCapture": "Start capture",
  "popup.statusError": "Error",
  "popup.statusErrorCopy": "Recording could not be started. Please try again.",
  "popup.statusRecording": "Recording",
  "popup.stopCapture": "Stop capture",
  "popup.tabVideoLabel": "Tab video",
  "popup.micLabel": "My voice",
  "popup.activeFem": "Active",
  "popup.activeMasc": "Active",
  "popup.notActive": "Not active",
  "popup.micMutedLabel": "Muted",
  "popup.processingMultiple": "Processing {{count}} meetings...",
  "popup.processingSingle": "Processing {{label}}... {{pct}}%",
  "popup.processingLabelVideo": "video",
  "popup.processingLabelAudio": "audio",
  "history.pageTitle": "Asterion — History",
  "history.pageHeading": "History",
  "history.pageDescription": "Meetings saved locally on this device.",
  "history.filtersAsideAria": "History filters",
  "history.searchPlaceholder": "Search by title",
  "history.filtersLabel": "Filters",
  "history.calendarAria": "Calendar",
  "history.summaryLabel": "Summary",
  "history.meetingsTitle": "Meetings",
  "history.sortAria": "Sort meetings",
  "history.sortNewest": "Newest first",
  "history.sortOldest": "Oldest first",
  "history.detailPanelAria": "Meeting detail",
  "history.filterAll": "All",
  "history.filterTranscript": "With transcript",
  "history.filterVideo": "With video",
  "history.filterAudioOnly": "Audio only",
  "history.filterThisMonth": "This month",
  "history.filterThisYear": "This year",
  "history.prevMonthAria": "Previous month",
  "history.nextMonthAria": "Next month",
  "history.kpiMeetingsThisMonth": "meetings this month",
  "history.kpiRecordingHours": "recorded",
  "history.kpiMeetingsWithVideo": "meetings with video",
  "history.kpiMeetingsWithTranscript": "meetings with transcript",
  "history.resultsCount": "{{count}} results",
  "history.emptyState": "No meetings match these filters yet.",
  "history.moreOptionsAria": "More options",
  "history.viewDetails": "View details",
  "history.seekAria": "Playback position",
  "history.mediaLoadError": "This media file could not be loaded.",
  "history.fullscreenAria": "Fullscreen",
  "history.playVideoAria": "Play video",
  "history.rewind10Aria": "Rewind 10 seconds",
  "history.forward10Aria": "Forward 10 seconds",
  "history.noTranscriptSegments": "No segments were found in the transcript.",
  "history.selectMeetingPlaceholder": "Select a meeting to see the detail",
  "history.loadingFile": "Loading file...",
  "history.fileOpenError": "This meeting file could not be opened.",
  "history.downloadTxt": "Download TXT",
  "history.downloadMarkdown": "Download Markdown",
  "history.deleteConfirmBody": "{{title}} and all its files will be deleted from this device. This action is permanent and cannot be undone."
}
```

- [ ] **Step 4: Create the Spanish dictionary**

Create `src/shared/i18n/locales/es.json`:

```json
{
  "common.untitledMeeting": "Reunión sin título",
  "common.transcript": "Transcripción",
  "common.audio": "Audio",
  "common.video": "Video",
  "common.manifest": "Manifest",
  "common.play": "Reproducir",
  "common.pause": "Pausar",
  "common.download": "Descargar",
  "common.open": "Abrir",
  "common.cancel": "Cancelar",
  "common.delete": "Eliminar",
  "common.deleteMeeting": "Eliminar reunión",
  "common.volumeAria": "Volumen",
  "common.meetingAudioLabel": "Audio de la reunión",
  "common.notAvailable": "No disponible",
  "settings.pageTitle": "Asterion — Configuración",
  "settings.backAria": "Volver",
  "settings.title": "Configuración",
  "settings.videoPresetLabel": "Velocidad y calidad del video",
  "settings.videoPresetHelper": "Más rápido = menos calidad/compresión, más lento = mejor compresión.",
  "popup.settingsAria": "Configuración",
  "popup.autoDetectLabel": "Detectar reuniones en Meet",
  "popup.autoDetectHelper": "Inicia la captura sola al entrar a una llamada de Meet. Esto aplica a cualquier reunión, no solo a la actual.",
  "popup.historyLink": "Ver historial",
  "popup.statusReady": "Listo",
  "popup.statusReadyCopy": "Abre una reunión de Google Meet para comenzar.",
  "popup.statusDetected": "Reunión detectada",
  "popup.startCapture": "Iniciar captura",
  "popup.statusError": "Error",
  "popup.statusErrorCopy": "No se pudo iniciar la grabación. Volvé a intentarlo.",
  "popup.statusRecording": "Grabando",
  "popup.stopCapture": "Detener captura",
  "popup.tabVideoLabel": "Video de la pestaña",
  "popup.micLabel": "Mi voz",
  "popup.activeFem": "Activa",
  "popup.activeMasc": "Activo",
  "popup.notActive": "No activo",
  "popup.micMutedLabel": "Silenciada",
  "popup.processingMultiple": "Procesando {{count}} reuniones...",
  "popup.processingSingle": "Procesando {{label}}... {{pct}}%",
  "popup.processingLabelVideo": "video",
  "popup.processingLabelAudio": "audio",
  "history.pageTitle": "Asterion — Historial",
  "history.pageHeading": "Historial",
  "history.pageDescription": "Reuniones guardadas localmente en este dispositivo.",
  "history.filtersAsideAria": "Filtros del historial",
  "history.searchPlaceholder": "Buscar por título",
  "history.filtersLabel": "Filtros",
  "history.calendarAria": "Calendario",
  "history.summaryLabel": "Resumen",
  "history.meetingsTitle": "Reuniones",
  "history.sortAria": "Ordenar reuniones",
  "history.sortNewest": "Más recientes primero",
  "history.sortOldest": "Más antiguas primero",
  "history.detailPanelAria": "Detalle de reunión",
  "history.filterAll": "Todas",
  "history.filterTranscript": "Con transcripción",
  "history.filterVideo": "Con video",
  "history.filterAudioOnly": "Solo audio",
  "history.filterThisMonth": "Este mes",
  "history.filterThisYear": "Este año",
  "history.prevMonthAria": "Mes anterior",
  "history.nextMonthAria": "Mes siguiente",
  "history.kpiMeetingsThisMonth": "reuniones este mes",
  "history.kpiRecordingHours": "de grabación",
  "history.kpiMeetingsWithVideo": "reuniones con video",
  "history.kpiMeetingsWithTranscript": "reuniones con transcripción",
  "history.resultsCount": "{{count}} resultados",
  "history.emptyState": "Todavía no hay reuniones que coincidan con estos filtros.",
  "history.moreOptionsAria": "Más opciones",
  "history.viewDetails": "Ver detalles",
  "history.seekAria": "Posición de reproducción",
  "history.mediaLoadError": "No se pudo cargar este archivo multimedia.",
  "history.fullscreenAria": "Pantalla completa",
  "history.playVideoAria": "Reproducir video",
  "history.rewind10Aria": "Retroceder 10 segundos",
  "history.forward10Aria": "Adelantar 10 segundos",
  "history.noTranscriptSegments": "No se encontraron intervenciones en la transcripción.",
  "history.selectMeetingPlaceholder": "Seleccioná una reunión para ver el detalle",
  "history.loadingFile": "Cargando archivo...",
  "history.fileOpenError": "No se pudo abrir este archivo de la reunión.",
  "history.downloadTxt": "Descargar TXT",
  "history.downloadMarkdown": "Descargar Markdown",
  "history.deleteConfirmBody": "Se eliminarán {{title}} y todos sus archivos de este dispositivo. Esta acción es permanente y no se puede deshacer."
}
```

- [ ] **Step 5: Create the French dictionary**

Create `src/shared/i18n/locales/fr.json`:

```json
{
  "common.untitledMeeting": "Réunion sans titre",
  "common.transcript": "Transcription",
  "common.audio": "Audio",
  "common.video": "Vidéo",
  "common.manifest": "Manifest",
  "common.play": "Lire",
  "common.pause": "Pause",
  "common.download": "Télécharger",
  "common.open": "Ouvrir",
  "common.cancel": "Annuler",
  "common.delete": "Supprimer",
  "common.deleteMeeting": "Supprimer la réunion",
  "common.volumeAria": "Volume",
  "common.meetingAudioLabel": "Audio de la réunion",
  "common.notAvailable": "Non disponible",
  "settings.pageTitle": "Asterion — Paramètres",
  "settings.backAria": "Retour",
  "settings.title": "Paramètres",
  "settings.videoPresetLabel": "Vitesse et qualité vidéo",
  "settings.videoPresetHelper": "Plus rapide = moins de qualité/compression, plus lent = meilleure compression.",
  "popup.settingsAria": "Paramètres",
  "popup.autoDetectLabel": "Détecter les réunions dans Meet",
  "popup.autoDetectHelper": "Démarre la capture automatiquement en rejoignant un appel Meet. Cela s'applique à toute réunion, pas seulement à l'actuelle.",
  "popup.historyLink": "Voir l'historique",
  "popup.statusReady": "Prêt",
  "popup.statusReadyCopy": "Ouvrez une réunion Google Meet pour commencer.",
  "popup.statusDetected": "Réunion détectée",
  "popup.startCapture": "Démarrer la capture",
  "popup.statusError": "Erreur",
  "popup.statusErrorCopy": "Impossible de démarrer l'enregistrement. Veuillez réessayer.",
  "popup.statusRecording": "Enregistrement",
  "popup.stopCapture": "Arrêter la capture",
  "popup.tabVideoLabel": "Vidéo de l'onglet",
  "popup.micLabel": "Ma voix",
  "popup.activeFem": "Active",
  "popup.activeMasc": "Actif",
  "popup.notActive": "Non actif",
  "popup.micMutedLabel": "Coupée",
  "popup.processingMultiple": "Traitement de {{count}} réunions...",
  "popup.processingSingle": "Traitement de {{label}}... {{pct}}%",
  "popup.processingLabelVideo": "vidéo",
  "popup.processingLabelAudio": "audio",
  "history.pageTitle": "Asterion — Historique",
  "history.pageHeading": "Historique",
  "history.pageDescription": "Réunions enregistrées localement sur cet appareil.",
  "history.filtersAsideAria": "Filtres de l'historique",
  "history.searchPlaceholder": "Rechercher par titre",
  "history.filtersLabel": "Filtres",
  "history.calendarAria": "Calendrier",
  "history.summaryLabel": "Résumé",
  "history.meetingsTitle": "Réunions",
  "history.sortAria": "Trier les réunions",
  "history.sortNewest": "Plus récentes d'abord",
  "history.sortOldest": "Plus anciennes d'abord",
  "history.detailPanelAria": "Détail de la réunion",
  "history.filterAll": "Toutes",
  "history.filterTranscript": "Avec transcription",
  "history.filterVideo": "Avec vidéo",
  "history.filterAudioOnly": "Audio seulement",
  "history.filterThisMonth": "Ce mois-ci",
  "history.filterThisYear": "Cette année",
  "history.prevMonthAria": "Mois précédent",
  "history.nextMonthAria": "Mois suivant",
  "history.kpiMeetingsThisMonth": "réunions ce mois-ci",
  "history.kpiRecordingHours": "d'enregistrement",
  "history.kpiMeetingsWithVideo": "réunions avec vidéo",
  "history.kpiMeetingsWithTranscript": "réunions avec transcription",
  "history.resultsCount": "{{count}} résultats",
  "history.emptyState": "Aucune réunion ne correspond encore à ces filtres.",
  "history.moreOptionsAria": "Plus d'options",
  "history.viewDetails": "Voir les détails",
  "history.seekAria": "Position de lecture",
  "history.mediaLoadError": "Ce fichier multimédia n'a pas pu être chargé.",
  "history.fullscreenAria": "Plein écran",
  "history.playVideoAria": "Lire la vidéo",
  "history.rewind10Aria": "Reculer de 10 secondes",
  "history.forward10Aria": "Avancer de 10 secondes",
  "history.noTranscriptSegments": "Aucun segment n'a été trouvé dans la transcription.",
  "history.selectMeetingPlaceholder": "Sélectionnez une réunion pour voir le détail",
  "history.loadingFile": "Chargement du fichier...",
  "history.fileOpenError": "Ce fichier de réunion n'a pas pu être ouvert.",
  "history.downloadTxt": "Télécharger TXT",
  "history.downloadMarkdown": "Télécharger Markdown",
  "history.deleteConfirmBody": "{{title}} et tous ses fichiers seront supprimés de cet appareil. Cette action est permanente et irréversible."
}
```

- [ ] **Step 6: Implement the i18n module**

Create `src/shared/i18n/i18n.js`:

```js
// src/shared/i18n/i18n.js
export const SUPPORTED_LOCALES = ["en", "es", "fr"];
export const DEFAULT_LOCALE = "en";
export const LOCALE_TAGS = { en: "en-US", es: "es-ES", fr: "fr-FR" };

export function detectLocale(rawLocale) {
  if (!rawLocale) return DEFAULT_LOCALE;
  const normalized = String(rawLocale).toLowerCase().split("-")[0];
  return SUPPORTED_LOCALES.includes(normalized) ? normalized : DEFAULT_LOCALE;
}

export function mergeWithFallback(target, fallback) {
  return { ...fallback, ...target };
}

export function interpolate(value, params) {
  if (typeof value !== "string" || !params) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function makeTranslator(dict) {
  return (key, params) => interpolate(key in dict ? dict[key] : key, params);
}

async function fetchDictionary(locale) {
  const url = chrome.runtime.getURL(`src/shared/i18n/locales/${locale}.json`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load the "${locale}" dictionary: HTTP ${response.status}`);
  return response.json();
}

async function safeFetchDictionary(locale) {
  try {
    return await fetchDictionary(locale);
  } catch (error) {
    console.error(`[i18n] could not load the "${locale}" dictionary`, error);
    return {};
  }
}

export async function initI18n(rawLocale = navigator.language) {
  const locale = detectLocale(rawLocale);
  const fallbackDict = locale === DEFAULT_LOCALE ? {} : await safeFetchDictionary(DEFAULT_LOCALE);
  const targetDict = await safeFetchDictionary(locale);
  const dict = mergeWithFallback(targetDict, fallbackDict);
  document.documentElement.lang = locale;
  return { locale, localeTag: LOCALE_TAGS[locale], t: makeTranslator(dict) };
}
```

`initI18n` never throws: if the target locale's JSON fails to load (missing file, bad network, malformed JSON), it silently falls back to the English dictionary; if even that fails, `dict` ends up `{}` and `t()` degrades to returning the raw key (via `makeTranslator`'s existing fallback) instead of crashing page startup. This matters because `popup.js` and `history.js` call `initI18n()` with a top-level `await` — an unhandled rejection there would block the whole module from evaluating.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/shared/i18n/i18n.test.js`
Expected: PASS (all `describe` blocks from Step 1 green).

- [ ] **Step 8: Add tests for `initI18n` and for dictionary completeness**

Append to `src/shared/i18n/i18n.test.js` (same file, new `describe` blocks below the existing ones):

```js
import enDict from "./locales/en.json";
import esDict from "./locales/es.json";
import frDict from "./locales/fr.json";
import { afterEach, vi } from "vitest";
import { initI18n } from "./i18n.js";

function mockDictionaryFetch(dictionariesByLocale) {
  globalThis.chrome = { runtime: { getURL: (path) => path } };
  globalThis.fetch = vi.fn((url) => {
    const locale = url.match(/locales\/([a-z]+)\.json$/)?.[1];
    const dict = dictionariesByLocale[locale];
    if (!dict) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => dict });
  });
}

describe("initI18n", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.chrome;
    delete globalThis.fetch;
    document.documentElement.lang = "";
  });

  it("loads and merges the target dictionary over the English fallback", async () => {
    mockDictionaryFetch({
      en: { "common.play": "Play", "common.pause": "Pause" },
      es: { "common.play": "Reproducir" },
    });
    const { t, locale, localeTag } = await initI18n("es-AR");
    expect(locale).toBe("es");
    expect(localeTag).toBe("es-ES");
    expect(t("common.play")).toBe("Reproducir");
    expect(t("common.pause")).toBe("Pause");
    expect(document.documentElement.lang).toBe("es");
  });

  it("uses the English dictionary directly when the detected locale is English", async () => {
    mockDictionaryFetch({ en: { "common.play": "Play" } });
    const { t } = await initI18n("en-GB");
    expect(t("common.play")).toBe("Play");
  });

  it("falls back to English for an unsupported locale", async () => {
    mockDictionaryFetch({ en: { "common.play": "Play" } });
    const { locale, t } = await initI18n("pt-BR");
    expect(locale).toBe("en");
    expect(t("common.play")).toBe("Play");
  });

  it("falls back to the English dictionary when the target locale fails to load", async () => {
    mockDictionaryFetch({ en: { "common.play": "Play" } }); // no "fr" entry -> fetch resolves ok:false
    const { t } = await initI18n("fr-FR");
    expect(t("common.play")).toBe("Play");
  });

  it("degrades to returning raw keys instead of throwing when every fetch fails", async () => {
    mockDictionaryFetch({}); // nothing resolves ok:true
    const { t } = await initI18n("es-ES");
    expect(t("common.play")).toBe("common.play");
  });
});

describe("dictionary completeness", () => {
  it("only ever defines keys in es/fr that also exist in the English dictionary", () => {
    const enKeys = new Set(Object.keys(enDict));
    for (const key of Object.keys(esDict)) expect(enKeys.has(key)).toBe(true);
    for (const key of Object.keys(frDict)) expect(enKeys.has(key)).toBe(true);
  });
});
```

Run: `npx vitest run src/shared/i18n/i18n.test.js`
Expected: PASS — all `describe` blocks green, including the new `initI18n` and `dictionary completeness` ones.

- [ ] **Step 9: Commit**

```bash
git add src/shared/i18n
git commit -m "feat: add i18n core module with en/es/fr dictionaries"
```

---

### Task 2: Translate the settings page

**Files:**
- Modify: `src/settings/settings.html`
- Modify: `src/settings/settings.js`

- [ ] **Step 1: Add ids to the translatable elements in settings.html**

In `src/settings/settings.html`, apply these three changes (the Spanish text stays in place as the initial-paint fallback; `settings.js` overwrites it once the dictionary loads):

Change:
```html
<button id="back-button" class="back-button" type="button" aria-label="Volver"></button>
<h1>Configuración</h1>
```
to:
```html
<button id="back-button" class="back-button" type="button" aria-label="Volver"></button>
<h1 id="page-heading">Configuración</h1>
```

Change:
```html
<label for="video-preset">Velocidad y calidad del video</label>
```
to:
```html
<label id="video-preset-label" for="video-preset">Velocidad y calidad del video</label>
```

Change:
```html
<p class="helper">Más rápido = menos calidad/compresión, más lento = mejor compresión.</p>
```
to:
```html
<p id="video-preset-helper" class="helper">Más rápido = menos calidad/compresión, más lento = mejor compresión.</p>
```

- [ ] **Step 2: Translate settings.js**

Replace the full contents of `src/settings/settings.js` with:

```js
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
```

This now matches `popup.js` and `history.js`: a single top-level `await initI18n()`, no `.then()`. Since `initI18n` never throws (Task 1, Step 6), this can't produce an unhandled rejection or leave the page half-initialized.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — this page has no dedicated tests, but this confirms the change didn't break anything else.

- [ ] **Step 4: Commit**

```bash
git add src/settings/settings.html src/settings/settings.js
git commit -m "feat: translate settings page via i18n module"
```

---

### Task 3: Translate the popup page

**Files:**
- Modify: `src/popup/popup.js`

- [ ] **Step 1: Replace the full contents of popup.js**

Replace the full contents of `src/popup/popup.js` with:

```js
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
    <div class="brand"><img src="${chrome.runtime.getURL("icons/icon32.png")}" width="18" height="18" alt="">Asterion</div>
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
      ${sourceRow("volume-2", t("common.meetingAudioLabel"), true, t("popup.activeMasc"), "")}
      ${sourceRow("mic", t("popup.micLabel"), !status.micMuted, t("popup.activeFem"), t("popup.micMutedLabel"))}
      ${sourceRow("app-window", t("popup.tabVideoLabel"), status.videoEnabled, t("popup.activeMasc"), t("popup.notActive"))}
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
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/popup/popup.js
git commit -m "feat: translate popup page via i18n module"
```

---

### Task 4: Translate the history page

**Files:**
- Modify: `src/history/history.html`
- Modify: `src/history/history.js`
- Test: `src/history/history.test.js`

- [ ] **Step 1: Add ids to the two static sidebar text elements in history.html**

In `src/history/history.html`, apply this change (Spanish text stays as the initial-paint fallback):

Change:
```html
<div><h1 class="sidebar-heading">Historial</h1><p class="sidebar-description">Reuniones guardadas localmente en este dispositivo.</p></div>
```
to:
```html
<div><h1 id="page-heading" class="sidebar-heading">Historial</h1><p id="page-description" class="sidebar-description">Reuniones guardadas localmente en este dispositivo.</p></div>
```

- [ ] **Step 2: Write a regression test locking down `deriveVisibleMeetings` before refactoring**

`history.js` has no existing test file (there is no pre-existing coverage for it in the repo), and Task 4's next step rewrites the whole file by hand. Add a baseline test first so a transcription mistake in the rewrite is caught immediately, per this project's TDD practice.

**Important:** `history.js` is a page script, not a pure module — importing it runs page-wiring code at the top level (`document.getElementById(...)`, `chrome.storage.local.get(...)`, event listener wiring, and, after Task 4 Step 3, `await initI18n()`). A bare `jsdom` environment has none of that DOM or `chrome` API, so importing the file without first building a matching fixture throws immediately (e.g. `Cannot set properties of null (setting 'innerHTML')`) before any test body runs. The test file below builds a minimal DOM fixture mirroring `history.html`'s real markup (same ids/classes the code queries) and a minimal `chrome`/`fetch` mock, all as top-level statements *before* dynamically importing `./history.js` — this must run before the dynamic import, so it cannot live inside a `beforeAll` hook (hooks run after the module's own top-level code has already executed). This same fixture works unchanged both now (baseline, no `initI18n` call yet) and after Step 3's rewrite (which does call it): the mocked `fetch` always resolves `{ ok: false }`, which Task 1's `safeFetchDictionary` already handles by falling back to `{}` instead of throwing.

Create `src/history/history.test.js`:

```js
import { describe, expect, it, vi } from "vitest";

document.body.innerHTML = `
  <aside class="sidebar" aria-label="Filtros del historial">
    <div class="brand"><img alt="" /><span>Asterion</span></div>
    <div><h1 id="page-heading" class="sidebar-heading">Historial</h1><p id="page-description" class="sidebar-description"></p></div>
    <div class="search-field"><span id="search-icon" class="search-icon" aria-hidden="true"></span><input id="search-input" type="search" /></div>
    <section aria-labelledby="filters-label" hidden><span id="filters-label" class="section-label"></span><div id="filter-chips" class="filter-chips"></div></section>
    <section class="calendar" aria-label="Calendario"><div id="calendar"></div></section>
    <section aria-labelledby="kpis-label"><span id="kpis-label" class="section-label"></span><div id="kpis" class="kpis"></div></section>
  </aside>
  <section class="meetings-panel" aria-labelledby="meetings-title">
    <header class="meetings-header"><div><h2 id="meetings-title" class="meetings-title"></h2><p id="results-count" class="results-count"></p></div><label class="sort-control"><select id="sort-select"><option value="newest">Newest</option><option value="oldest">Oldest</option></select><span id="sort-chevron" class="sort-chevron" aria-hidden="true"></span></label></header>
    <div id="meetings-list" class="meetings-list" aria-live="polite"></div>
  </section>
  <section id="detail-panel" class="detail-panel" aria-label="Detalle de reunión"></section>
`;

globalThis.chrome = {
  runtime: { getURL: (path) => path },
  storage: {
    local: {
      get: (defaults, callback) => callback(defaults),
      set: () => {},
    },
    onChanged: { addListener: () => {} },
  },
  tabs: { create: () => {}, sendMessage: () => {} },
  downloads: { download: () => {}, onChanged: { addListener: () => {}, removeListener: () => {} } },
};
globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));

const { deriveVisibleMeetings } = await import("./history.js");

function meeting(overrides) {
  return {
    sessionId: "s1",
    folderName: "folder-1",
    meetingTitle: "Weekly sync",
    startedAt: new Date("2026-01-05T10:00:00Z").getTime(),
    hasTranscript: true,
    hasVideo: false,
    ...overrides,
  };
}

describe("deriveVisibleMeetings", () => {
  it("filters by search text (case/locale-insensitive)", () => {
    const state = { meetings: [meeting({ meetingTitle: "Café con equipo" })], search: "CAFÉ", filters: {}, sort: "newest", selectedDay: null };
    expect(deriveVisibleMeetings(state)).toHaveLength(1);
  });

  it("excludes meetings without a transcript when the transcript filter is on", () => {
    const state = { meetings: [meeting({ hasTranscript: false })], search: "", filters: { transcript: true }, sort: "newest", selectedDay: null };
    expect(deriveVisibleMeetings(state)).toHaveLength(0);
  });

  it("sorts oldest first when requested", () => {
    const older = meeting({ sessionId: "old", startedAt: new Date("2026-01-01T00:00:00Z").getTime() });
    const newer = meeting({ sessionId: "new", startedAt: new Date("2026-01-10T00:00:00Z").getTime() });
    const state = { meetings: [newer, older], search: "", filters: {}, sort: "oldest", selectedDay: null };
    expect(deriveVisibleMeetings(state).map((m) => m.sessionId)).toEqual(["old", "new"]);
  });
});
```

Run: `npx vitest run src/history/history.test.js`
Expected: PASS against the **current, unmodified** `history.js` — this is the baseline. If it fails here, stop and investigate before touching `history.js`.

- [ ] **Step 3: Replace the full contents of history.js**

Replace the full contents of `src/history/history.js` with:

```js
// src/history/history.js
import { icon } from "../shared/icons.js";
import { formatSegmentTimestamp, transcriptToTxt, transcriptToMarkdown } from "../lib/transcript-export.js";
import { initI18n } from "../shared/i18n/i18n.js";

const { t, localeTag } = await initI18n();
document.title = t("history.pageTitle");

const searchInput = document.getElementById("search-input");
const filterChipsEl = document.getElementById("filter-chips");
const calendarEl = document.getElementById("calendar");
const kpisEl = document.getElementById("kpis");
const resultsCountEl = document.getElementById("results-count");
const sortSelect = document.getElementById("sort-select");
const meetingsListEl = document.getElementById("meetings-list");
const detailPanelEl = document.getElementById("detail-panel");
let activeMediaElement = null;
let activeMediaUrl = null;

document.getElementById("page-heading").textContent = t("history.pageHeading");
document.getElementById("page-description").textContent = t("history.pageDescription");
document.querySelector(".sidebar").setAttribute("aria-label", t("history.filtersAsideAria"));
searchInput.placeholder = t("history.searchPlaceholder");
searchInput.setAttribute("aria-label", t("history.searchPlaceholder"));
document.getElementById("filters-label").textContent = t("history.filtersLabel");
document.querySelector(".calendar").setAttribute("aria-label", t("history.calendarAria"));
document.getElementById("kpis-label").textContent = t("history.summaryLabel");
document.getElementById("meetings-title").textContent = t("history.meetingsTitle");
sortSelect.setAttribute("aria-label", t("history.sortAria"));
sortSelect.querySelector('option[value="newest"]').textContent = t("history.sortNewest");
sortSelect.querySelector('option[value="oldest"]').textContent = t("history.sortOldest");
detailPanelEl.setAttribute("aria-label", t("history.detailPanelAria"));

document.getElementById("search-icon").innerHTML = icon("search", { size: 15, color: "var(--text-muted)" });
document.getElementById("sort-chevron").innerHTML = icon("chevron-down", { size: 12, color: "var(--text-muted)" });

function downloadFile(file, suggestedName) {
  const url = URL.createObjectURL(file);
  chrome.downloads.download({ url, filename: suggestedName, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError || downloadId === undefined) {
      URL.revokeObjectURL(url);
      return;
    }
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
        URL.revokeObjectURL(url);
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

function viewFile(file) {
  chrome.tabs.create({ url: URL.createObjectURL(file) });
}

const state = {
  meetings: [], search: "",
  filters: { transcript: false, video: false, audioOnly: false, thisMonth: false, thisYear: false },
  calendarMonth: startOfMonth(new Date()), selectedDay: null, sort: "newest", selectedMeetingId: null, selectedTab: null,
};

const FILTERS = () => [["all", t("history.filterAll")], ["transcript", t("history.filterTranscript")], ["video", t("history.filterVideo")], ["audioOnly", t("history.filterAudioOnly")], ["thisMonth", t("history.filterThisMonth")], ["thisYear", t("history.filterThisYear")]];

function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function dayKey(date) { return new Date(date).toDateString(); }
function sameLocalDay(left, right) { return dayKey(left) === dayKey(right); }
function isInCurrentMonth(date, now = new Date()) { return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth(); }
function isInCurrentYear(date, now = new Date()) { return date.getFullYear() === now.getFullYear(); }
function titleFor(meeting) { return meeting.meetingTitle || meeting.folderName || t("common.untitledMeeting"); }
function meetingId(meeting) { return meeting.sessionId || meeting.folderName; }
function endTime(meeting) {
  const startedAt = Number(meeting.startedAt);
  return meeting.endedAt ?? (meeting.durationMs != null ? startedAt + Number(meeting.durationMs) : startedAt);
}
function durationOf(meeting) {
  if (meeting.durationMs != null) return Number(meeting.durationMs);
  if (meeting.endedAt != null) return Number(meeting.endedAt) - Number(meeting.startedAt);
  return 0;
}

export function deriveVisibleMeetings(currentState) {
  const normalizedSearch = currentState.search.trim().toLocaleLowerCase();
  const { transcript, video, audioOnly, thisMonth, thisYear } = currentState.filters;
  const now = new Date();
  const visible = currentState.meetings.filter((meeting) => {
    const startedAt = new Date(meeting.startedAt);
    if (Number.isNaN(startedAt.getTime())) return false;
    if (normalizedSearch && !titleFor(meeting).toLocaleLowerCase().includes(normalizedSearch)) return false;
    if (transcript && !meeting.hasTranscript) return false;
    if (video && !meeting.hasVideo) return false;
    if (audioOnly && meeting.hasVideo) return false;
    if (thisMonth && !isInCurrentMonth(startedAt, now)) return false;
    if (thisYear && !isInCurrentYear(startedAt, now)) return false;
    return !currentState.selectedDay || sameLocalDay(startedAt, currentState.selectedDay);
  });
  return visible.sort((left, right) => currentState.sort === "oldest" ? left.startedAt - right.startedAt : right.startedAt - left.startedAt);
}

function formatMonth(date) { return `${capitalize(new Intl.DateTimeFormat(localeTag, { month: "long" }).format(date))} ${date.getFullYear()}`; }
function capitalize(text) { return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text; }
function weekdayShortLabels() {
  const formatter = new Intl.DateTimeFormat(localeTag, { weekday: "short" });
  // 2024-01-01 is a Monday; formatting Mon..Sun from a fixed reference week
  // keeps this independent of the calendar actually being rendered.
  return Array.from({ length: 7 }, (_, index) => capitalize(formatter.format(new Date(2024, 0, 1 + index)).replace(".", "")));
}
function formatMeetingDate(meeting) {
  const started = new Date(meeting.startedAt);
  const ended = new Date(endTime(meeting));
  const date = capitalize(new Intl.DateTimeFormat(localeTag, { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(started).replace(".", ""));
  const time = new Intl.DateTimeFormat(localeTag, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} · ${time.format(started)} – ${time.format(ended)}`;
}
function formatDetailDate(meeting) { return capitalize(new Intl.DateTimeFormat(localeTag, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(meeting.startedAt))); }
function formatTimeRange(meeting) { const formatter = new Intl.DateTimeFormat(localeTag, { hour: "2-digit", minute: "2-digit", hour12: false }); return `${formatter.format(new Date(meeting.startedAt))} – ${formatter.format(new Date(endTime(meeting)))}`; }
function formatDurationHours(totalMs) { const hours = Math.ceil((Math.max(0, totalMs) / 3600000) * 10) / 10; return `${hours} h`; }
function formatMediaTime(seconds) { if (!Number.isFinite(seconds) || seconds < 0) return "0:00"; const totalSeconds = Math.floor(seconds); return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`; }
function formatFileSize(bytes) { if (!Number.isFinite(bytes)) return ""; const units = ["B", "KB", "MB", "GB"]; let value = bytes; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; } return `${value.toLocaleString(localeTag, { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`; }
function allFiltersOff() { return Object.values(state.filters).every((active) => !active); }

function renderSidebar() { renderFilters(); renderCalendar(); renderKpis(); }

function renderFilters() {
  filterChipsEl.replaceChildren();
  for (const [key, label] of FILTERS()) {
    const button = document.createElement("button");
    const active = key === "all" ? allFiltersOff() : state.filters[key];
    button.type = "button"; button.className = `filter-chip${active ? " is-active" : ""}`; button.textContent = label; button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", () => {
      if (key === "all") Object.keys(state.filters).forEach((filter) => { state.filters[filter] = false; });
      else state.filters[key] = !state.filters[key];
      renderAllExceptDetail();
    });
    filterChipsEl.appendChild(button);
  }
}

function renderCalendar() {
  calendarEl.replaceChildren();
  const header = document.createElement("div"); header.className = "calendar-header";
  const heading = document.createElement("div"); heading.className = "calendar-title";
  const month = document.createElement("span"); month.textContent = formatMonth(state.calendarMonth); heading.appendChild(month);
  const controls = document.createElement("div"); controls.className = "calendar-controls";
  controls.append(createCalendarButton("chevron-left", t("history.prevMonthAria"), -1), createCalendarButton("chevron-right", t("history.nextMonthAria"), 1));
  header.append(heading, controls); calendarEl.appendChild(header);
  const weekdays = document.createElement("div"); weekdays.className = "calendar-weekdays";
  weekdayShortLabels().forEach((label) => { const day = document.createElement("span"); day.textContent = label; weekdays.appendChild(day); });
  calendarEl.appendChild(weekdays);
  const days = document.createElement("div"); days.className = "calendar-days";
  const first = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth(), 1);
  const gridStart = new Date(first); gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const meetingDays = new Set(state.meetings.map((meeting) => dayKey(meeting.startedAt)));
  const today = new Date();
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart); date.setDate(gridStart.getDate() + index);
    const selected = state.selectedDay && sameLocalDay(date, state.selectedDay);
    const button = document.createElement("button"); button.type = "button";
    button.className = `calendar-day${date.getMonth() !== state.calendarMonth.getMonth() ? " is-outside" : ""}${sameLocalDay(date, today) ? " is-today" : ""}${selected ? " is-selected" : ""}`;
    button.textContent = String(date.getDate()); button.setAttribute("aria-label", new Intl.DateTimeFormat(localeTag, { dateStyle: "full" }).format(date)); button.setAttribute("aria-pressed", String(Boolean(selected)));
    if (meetingDays.has(dayKey(date))) { const dot = document.createElement("span"); dot.className = "meeting-dot"; dot.setAttribute("aria-hidden", "true"); button.appendChild(dot); }
    button.addEventListener("click", () => { state.selectedDay = selected ? null : date; renderAllExceptDetail(); });
    days.appendChild(button);
  }
  calendarEl.appendChild(days);
}

function createCalendarButton(iconName, label, offset) {
  const button = document.createElement("button"); button.type = "button"; button.className = "icon-button"; button.setAttribute("aria-label", label); button.innerHTML = icon(iconName, { size: 16, color: "var(--text-secondary)" });
  button.addEventListener("click", () => { state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + offset, 1); renderCalendar(); });
  return button;
}

function renderKpis() {
  kpisEl.replaceChildren();
  const thisMonth = state.meetings.filter((meeting) => isInCurrentMonth(new Date(meeting.startedAt)));
  const rows = [[String(thisMonth.length), t("history.kpiMeetingsThisMonth")], [formatDurationHours(thisMonth.reduce((total, meeting) => total + durationOf(meeting), 0)), t("history.kpiRecordingHours")], [String(state.meetings.filter((meeting) => meeting.hasVideo).length), t("history.kpiMeetingsWithVideo")], [String(state.meetings.filter((meeting) => meeting.hasTranscript).length), t("history.kpiMeetingsWithTranscript")]];
  rows.forEach(([value, label]) => { const row = document.createElement("div"); row.className = "kpi-row"; const valueEl = document.createElement("strong"); valueEl.className = "kpi-value"; valueEl.textContent = value; const labelEl = document.createElement("span"); labelEl.className = "kpi-label"; labelEl.textContent = label; row.append(valueEl, labelEl); kpisEl.appendChild(row); });
}

function renderMeetings() {
  const meetings = deriveVisibleMeetings(state); resultsCountEl.textContent = t("history.resultsCount", { count: meetings.length }); meetingsListEl.replaceChildren();
  if (!meetings.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = t("history.emptyState"); meetingsListEl.appendChild(empty); return; }
  meetings.forEach((meeting) => meetingsListEl.appendChild(createMeetingCard(meeting)));
}

function closeOpenMoreMenu() {
  meetingsListEl.querySelector(".more-menu")?.remove();
  meetingsListEl.querySelectorAll(".more-button.is-open").forEach((button) => { button.classList.remove("is-open"); button.setAttribute("aria-expanded", "false"); });
}
document.addEventListener("click", closeOpenMoreMenu);

function openMeetingDetail(meeting, tab) {
  state.selectedMeetingId = meetingId(meeting); state.selectedTab = tab ?? null; renderMeetings(); renderDetail();
}

function createMeetingCard(meeting) {
  const card = document.createElement("article"); card.className = `meeting-card${meetingId(meeting) === state.selectedMeetingId ? " is-selected" : ""}`;
  card.addEventListener("click", () => openMeetingDetail(meeting));
  const header = document.createElement("div"); header.className = "meeting-card-header";
  const title = document.createElement("h3"); title.className = "meeting-title"; title.textContent = titleFor(meeting);
  const moreWrap = document.createElement("div"); moreWrap.className = "more-wrap";
  const more = document.createElement("button"); more.type = "button"; more.className = "more-button"; more.setAttribute("aria-label", t("history.moreOptionsAria")); more.setAttribute("aria-haspopup", "true"); more.setAttribute("aria-expanded", "false"); more.innerHTML = icon("ellipsis", { size: 17, color: "currentColor" });
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasOpen = more.classList.contains("is-open");
    closeOpenMoreMenu();
    if (wasOpen) return;
    more.classList.add("is-open"); more.setAttribute("aria-expanded", "true");
    const menu = document.createElement("div"); menu.className = "more-menu"; menu.setAttribute("role", "menu");
    const deleteItem = document.createElement("button"); deleteItem.type = "button"; deleteItem.className = "more-menu-item"; deleteItem.setAttribute("role", "menuitem");
    deleteItem.innerHTML = icon("trash-2", { size: 14, color: "currentColor" });
    deleteItem.appendChild(document.createTextNode(t("common.deleteMeeting")));
    deleteItem.addEventListener("click", (deleteEvent) => { deleteEvent.stopPropagation(); closeOpenMoreMenu(); showDeleteDialog(meeting, more); });
    menu.appendChild(deleteItem);
    moreWrap.appendChild(menu);
  });
  moreWrap.appendChild(more);
  header.append(title, moreWrap);
  const date = document.createElement("p"); date.className = "meeting-date"; date.textContent = formatMeetingDate(meeting);
  const chips = document.createElement("div"); chips.className = "file-chips";
  [[meeting.hasTranscript, "file-text", t("common.transcript"), "transcript"], [true, "volume-2", t("common.audio"), "audio"], [meeting.hasVideo, "video", t("common.video"), "video"], [true, "braces", t("common.manifest"), "manifest"]].forEach(([available, iconName, label, tab]) => {
    const chip = document.createElement("span"); chip.className = `file-chip${available ? " is-available" : " is-unavailable"}`;
    chip.innerHTML = icon(iconName, { size: 12, color: "currentColor" });
    chip.appendChild(document.createTextNode(label));
    if (available) { chip.setAttribute("role", "button"); chip.tabIndex = 0; chip.addEventListener("click", (event) => { event.stopPropagation(); openMeetingDetail(meeting, tab); }); }
    chips.appendChild(chip);
  });
  const detailsRow = document.createElement("div"); detailsRow.className = "details-row";
  const details = document.createElement("button"); details.type = "button"; details.className = "details-button"; details.textContent = t("history.viewDetails");
  detailsRow.appendChild(details);
  card.append(header, date, chips, detailsRow); return card;
}

function availableTabs(meeting) { return [[meeting.hasTranscript, "transcript", t("common.transcript")], [true, "audio", t("common.audio")], [meeting.hasVideo, "video", t("common.video")], [true, "manifest", t("common.manifest")]].filter(([available]) => available); }
function escapeHtml(value) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function highlightJson(value) {
  const escaped = escapeHtml(JSON.stringify(value, null, 2));
  return escaped.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, (token, string, colon, literal) => {
    const className = string ? (colon ? "json-key" : "json-string") : (literal ? "json-literal" : "json-number");
    return `<span class="${className}">${token}</span>`;
  });
}
async function openMeetingDirectory(meeting) { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(meeting.folderName); }
async function readJsonFile(directory) { const file = await (await directory.getFileHandle("manifest.json")).getFile(); return { file, value: JSON.parse(await file.text()) }; }
async function readActiveFile(meeting, tab) {
  const directory = await openMeetingDirectory(meeting);
  if (tab === "transcript") { const file = await (await directory.getFileHandle("transcripcion.json")).getFile(); return { file, name: "transcripcion.json", value: JSON.parse(await file.text()) }; }
  if (tab === "manifest") { const { file, value } = await readJsonFile(directory); return { file, name: "manifest.json", value }; }
  const { value: manifest } = await readJsonFile(directory).catch(() => ({ value: {} }));
  const isVideo = tab === "video"; const converted = isVideo ? (manifest.hasVideoMp4 || manifest.videoConversionStatus === "succeeded") : (manifest.hasAudioMp3 || manifest.audioConversionStatus === "succeeded");
  const preferred = isVideo ? (converted ? "video-reunion.mp4" : "video-reunion.webm") : (converted ? "audio-reunion.mp3" : "audio-reunion.webm");
  const fallback = isVideo ? (preferred.endsWith(".mp4") ? "video-reunion.webm" : "video-reunion.mp4") : (preferred.endsWith(".mp3") ? "audio-reunion.webm" : "audio-reunion.mp3");
  try { return { file: await (await directory.getFileHandle(preferred)).getFile(), name: preferred }; } catch { return { file: await (await directory.getFileHandle(fallback)).getFile(), name: fallback }; }
}
function createFileFooter(activeFile, meeting) {
  const footer = document.createElement("footer"); footer.className = "detail-footer";
  const fileRow = document.createElement("div"); fileRow.className = "detail-file-row";
  const metadata = document.createElement("div"); metadata.className = "detail-file-meta"; const name = document.createElement("span"); name.className = "detail-file-name"; name.textContent = activeFile.name; const size = document.createElement("span"); size.className = "detail-file-size"; size.textContent = formatFileSize(activeFile.file.size); metadata.append(name, size);
  const actions = document.createElement("div"); actions.className = "detail-file-actions";
  const view = document.createElement("button"); view.type = "button"; view.className = "detail-action"; view.innerHTML = `${icon("external-link", { size: 12, color: "currentColor" })}<span>${t("common.open")}</span>`; view.addEventListener("click", () => viewFile(activeFile.file));
  const download = document.createElement("button"); download.type = "button"; download.className = "detail-action"; download.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>${t("common.download")}</span>`; download.addEventListener("click", () => downloadFile(activeFile.file, activeFile.name));
  actions.append(view, download);
  if (state.selectedTab === "transcript") {
    const downloadTxt = document.createElement("button"); downloadTxt.type = "button"; downloadTxt.className = "detail-action"; downloadTxt.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>${t("history.downloadTxt")}</span>`;
    downloadTxt.addEventListener("click", () => downloadFile(new Blob([transcriptToTxt(activeFile.value)], { type: "text/plain" }), "transcripcion.txt"));
    const downloadMd = document.createElement("button"); downloadMd.type = "button"; downloadMd.className = "detail-action"; downloadMd.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>${t("history.downloadMarkdown")}</span>`;
    downloadMd.addEventListener("click", () => downloadFile(new Blob([transcriptToMarkdown(activeFile.value, titleFor(meeting))], { type: "text/markdown" }), "transcripcion.md"));
    actions.append(downloadTxt, downloadMd);
  }
  const separator = document.createElement("span"); separator.className = "detail-footer-separator"; separator.setAttribute("aria-hidden", "true");
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-meeting-button"; remove.innerHTML = `${icon("trash-2", { size: 14, color: "currentColor" })}<span>${t("common.deleteMeeting")}</span>`; remove.addEventListener("click", () => showDeleteDialog(state.meetings.find((item) => meetingId(item) === state.selectedMeetingId), remove));
  fileRow.append(metadata, actions); footer.append(fileRow, separator, remove); return footer;
}
function cleanupActiveMedia() {
  if (activeMediaElement) { activeMediaElement.pause(); activeMediaElement.removeAttribute("src"); activeMediaElement.load(); activeMediaElement = null; }
  if (activeMediaUrl) { URL.revokeObjectURL(activeMediaUrl); activeMediaUrl = null; }
}
function createMediaButton(className, label, iconName, size = 18) {
  const button = document.createElement("button"); button.type = "button"; button.className = className; button.setAttribute("aria-label", label); button.title = label; button.innerHTML = icon(iconName, { size, color: "currentColor" }); return button;
}
function setRangeProgress(range, value, max) { range.style.setProperty("--range-progress", `${max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0}%`); }
function createMediaPlayer(activeFile, isVideo) {
  const player = document.createElement("div"); player.className = `custom-media-player${isVideo ? " custom-video-player" : " custom-audio-player"}`;
  const media = document.createElement(isVideo ? "video" : "audio"); media.className = isVideo ? "custom-video-element" : "custom-audio-element"; media.preload = "metadata"; media.controls = false;
  const sourceUrl = URL.createObjectURL(activeFile.file); activeMediaElement = media; activeMediaUrl = sourceUrl;
  const seek = document.createElement("input"); seek.type = "range"; seek.className = "media-seek"; seek.min = "0"; seek.max = "0"; seek.value = "0"; seek.step = "0.1"; seek.disabled = true; seek.setAttribute("aria-label", t("history.seekAria"));
  const time = document.createElement("span"); time.className = "media-time";
  const volume = document.createElement("input"); volume.type = "range"; volume.className = "media-volume"; volume.min = "0"; volume.max = "1"; volume.value = "1"; volume.step = "0.05"; volume.setAttribute("aria-label", t("common.volumeAria")); setRangeProgress(volume, 1, 1);
  const play = createMediaButton("media-play", t("common.play"), "play", isVideo ? 18 : 20);
  const update = () => { const duration = Number.isFinite(media.duration) ? media.duration : 0; seek.max = String(duration); seek.disabled = duration <= 0; seek.value = String(Math.min(media.currentTime || 0, duration)); setRangeProgress(seek, Number(seek.value), duration); time.textContent = `${formatMediaTime(media.currentTime)} / ${formatMediaTime(duration)}`; };
  const updatePlayButton = () => { const paused = media.paused || media.ended; play.setAttribute("aria-label", paused ? t("common.play") : t("common.pause")); play.title = paused ? t("common.play") : t("common.pause"); play.innerHTML = icon(paused ? "play" : "pause", { size: isVideo ? 18 : 20, color: "currentColor" }); player.classList.toggle("is-playing", !paused); };
  const togglePlayback = async () => { if (media.paused || media.ended) { try { await media.play(); } catch { updatePlayButton(); } } else media.pause(); };
  play.addEventListener("click", togglePlayback); seek.addEventListener("input", () => { if (!seek.disabled) media.currentTime = Number(seek.value); update(); }); volume.addEventListener("input", () => { media.volume = Number(volume.value); setRangeProgress(volume, media.volume, 1); });
  media.addEventListener("loadedmetadata", update); media.addEventListener("durationchange", update); media.addEventListener("timeupdate", update); media.addEventListener("play", updatePlayButton); media.addEventListener("pause", updatePlayButton); media.addEventListener("ended", () => { update(); updatePlayButton(); }); media.addEventListener("error", () => { const error = document.createElement("p"); error.className = "media-error"; error.textContent = t("history.mediaLoadError"); player.appendChild(error); });
  if (isVideo) {
    const controls = document.createElement("div"); controls.className = "video-controls"; const volumeWrap = document.createElement("label"); volumeWrap.className = "media-volume-control"; volumeWrap.setAttribute("aria-label", t("common.volumeAria")); volumeWrap.innerHTML = icon("volume-2", { size: 17, color: "currentColor" }); volumeWrap.appendChild(volume);
    const fullscreen = createMediaButton("media-control-button", t("history.fullscreenAria"), "maximize", 17); fullscreen.addEventListener("click", () => { media.requestFullscreen().catch(() => {}); });
    const largePlay = createMediaButton("video-large-play", t("history.playVideoAria"), "play", 28); largePlay.addEventListener("click", togglePlayback); controls.append(play, seek, time, volumeWrap, fullscreen); player.append(media, largePlay, controls);
  } else {
    const label = document.createElement("p"); label.className = "audio-player-label"; label.textContent = t("common.meetingAudioLabel");
    const transport = document.createElement("div"); transport.className = "audio-transport"; const rewind = createMediaButton("media-round-button", t("history.rewind10Aria"), "rotate-ccw", 16); rewind.addEventListener("click", () => { media.currentTime = Math.max(0, media.currentTime - 10); }); const forward = createMediaButton("media-round-button", t("history.forward10Aria"), "rotate-cw", 16); forward.addEventListener("click", () => { media.currentTime = Math.min(Number.isFinite(media.duration) ? media.duration : media.currentTime + 10, media.currentTime + 10); }); transport.append(rewind, play, forward, time);
    const volumeWrap = document.createElement("label"); volumeWrap.className = "media-volume-control"; volumeWrap.setAttribute("aria-label", t("common.volumeAria")); volumeWrap.innerHTML = icon("volume-2", { size: 16, color: "var(--text-secondary)" }); volumeWrap.appendChild(volume); player.append(label, media, transport, seek, volumeWrap);
  }
  media.src = sourceUrl; update(); return player;
}
function renderTabContent(content, activeFile) {
  if (state.selectedTab === "transcript") {
    const list = document.createElement("div"); list.className = "transcript-list";
    activeFile.value.forEach((segment) => { const row = document.createElement("div"); row.className = "transcript-row"; const timestamp = document.createElement("time"); timestamp.className = "transcript-time"; timestamp.textContent = formatSegmentTimestamp(segment.startTime); const spoken = document.createElement("p"); spoken.className = "transcript-spoken"; const speaker = document.createElement("strong"); speaker.textContent = segment.speaker; spoken.append(speaker, document.createTextNode(` ${segment.text}`)); row.append(timestamp, spoken); list.appendChild(row); });
    if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "detail-empty"; empty.textContent = t("history.noTranscriptSegments"); content.appendChild(empty); } else content.appendChild(list);
  } else if (state.selectedTab === "manifest") { const code = document.createElement("pre"); code.className = "manifest-code"; code.innerHTML = highlightJson(activeFile.value); content.appendChild(code); }
  else content.appendChild(createMediaPlayer(activeFile, state.selectedTab === "video"));
}
async function renderDetail() {
  cleanupActiveMedia(); detailPanelEl.replaceChildren(); const meeting = state.meetings.find((item) => meetingId(item) === state.selectedMeetingId);
  if (!meeting) { const placeholder = document.createElement("p"); placeholder.className = "detail-placeholder"; placeholder.textContent = t("history.selectMeetingPlaceholder"); detailPanelEl.appendChild(placeholder); return; }
  const tabs = availableTabs(meeting); if (!tabs.some(([, key]) => key === state.selectedTab)) state.selectedTab = tabs[0][1];
  const renderKey = `${meetingId(meeting)}:${state.selectedTab}`;
  const detail = document.createElement("div"); detail.className = "detail-content";
  const header = document.createElement("header"); header.className = "detail-header"; const title = document.createElement("h2"); title.className = "detail-title"; title.textContent = titleFor(meeting); const date = document.createElement("p"); date.className = "detail-date"; date.textContent = formatDetailDate(meeting); const metadata = document.createElement("p"); metadata.className = "detail-metadata"; metadata.textContent = `${formatTimeRange(meeting)} · Google Meet`; header.append(title, date, metadata);
  const tablist = document.createElement("div"); tablist.className = "detail-tabs"; tablist.setAttribute("role", "tablist"); const tabIcons = { transcript: "file-text", audio: "volume-2", video: "video", manifest: "braces" }; tabs.forEach(([, key, label]) => { const tab = document.createElement("button"); const active = key === state.selectedTab; tab.type = "button"; tab.className = `detail-tab${active ? " is-active" : ""}`; tab.innerHTML = `${icon(tabIcons[key], { size: 14, color: "currentColor" })}<span>${label}</span>`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(active)); tab.addEventListener("click", () => { state.selectedTab = key; renderDetail(); }); tablist.appendChild(tab); });
  const content = document.createElement("section"); content.className = `detail-tab-content${state.selectedTab === "audio" ? " is-audio" : state.selectedTab === "video" ? " is-video" : ""}`; content.setAttribute("role", "tabpanel"); const loading = document.createElement("p"); loading.className = "detail-loading"; loading.textContent = t("history.loadingFile"); content.appendChild(loading); detail.append(header, tablist, content); detailPanelEl.appendChild(detail);
  try { const activeFile = await readActiveFile(meeting, state.selectedTab); if (`${state.selectedMeetingId}:${state.selectedTab}` !== renderKey) return; content.replaceChildren(); renderTabContent(content, activeFile); detail.appendChild(createFileFooter(activeFile, meeting)); } catch (error) { if (`${state.selectedMeetingId}:${state.selectedTab}` !== renderKey) return; content.replaceChildren(); const unavailable = document.createElement("p"); unavailable.className = "detail-empty"; unavailable.textContent = t("history.fileOpenError"); content.appendChild(unavailable); }
}
function showDeleteDialog(meeting, opener) {
  if (!meeting) return;
  const overlay = document.createElement("div"); overlay.className = "delete-modal-backdrop"; overlay.setAttribute("role", "presentation");
  const dialog = document.createElement("section"); dialog.className = "delete-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-labelledby", "delete-modal-title"); const title = document.createElement("h2"); title.id = "delete-modal-title"; title.textContent = t("common.deleteMeeting"); const body = document.createElement("p"); body.textContent = t("history.deleteConfirmBody", { title: titleFor(meeting) }); const actions = document.createElement("div"); actions.className = "delete-modal-actions"; const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "modal-cancel"; cancel.textContent = t("common.cancel"); const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = "modal-confirm"; confirm.textContent = t("common.delete"); actions.append(cancel, confirm); dialog.append(title, body, actions); overlay.appendChild(dialog); document.body.appendChild(overlay);
  const close = () => { document.removeEventListener("keydown", onKeydown); overlay.remove(); opener.focus(); };
  const onKeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } if (event.key === "Tab") { const controls = [...dialog.querySelectorAll("button:not([disabled])")]; const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } };
  cancel.addEventListener("click", close); confirm.addEventListener("click", async () => { confirm.disabled = true; try { const root = await navigator.storage.getDirectory(); await root.removeEntry(meeting.folderName, { recursive: true }); const meetingHistory = state.meetings.filter((item) => meetingId(item) !== meetingId(meeting)); await chrome.storage.local.set({ meetingHistory }); state.meetings = meetingHistory; state.selectedMeetingId = null; state.selectedTab = null; renderAllExceptDetail(); renderDetail(); close(); } catch { confirm.disabled = false; } });
  document.addEventListener("keydown", onKeydown); cancel.focus();
}
function renderAllExceptDetail() { renderSidebar(); renderMeetings(); }

searchInput.addEventListener("input", () => { state.search = searchInput.value; renderAllExceptDetail(); });
sortSelect.addEventListener("change", () => { state.sort = sortSelect.value; renderMeetings(); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.meetingHistory) return;
  state.meetings = Array.isArray(changes.meetingHistory.newValue) ? changes.meetingHistory.newValue : [];
  if (state.selectedMeetingId && !state.meetings.some((meeting) => meetingId(meeting) === state.selectedMeetingId)) state.selectedMeetingId = null;
  renderAllExceptDetail(); renderDetail();
});
chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => { state.meetings = Array.isArray(meetingHistory) ? meetingHistory : []; renderAllExceptDetail(); renderDetail(); });
```

- [ ] **Step 4: Run the regression test and the full test suite**

Run: `npx vitest run src/history/history.test.js`
Expected: PASS — same three cases as the Step 2 baseline, now against the rewritten file. If any fail, the rewrite introduced a behavioral change in `deriveVisibleMeetings`; compare against the original function (Step 3's version is a straight copy with only strings/locale swapped, no logic changes).

Run: `npm test`
Expected: PASS across the whole suite.

- [ ] **Step 5: Verify no hardcoded Spanish text was missed**

Run:
```bash
grep -noE '"[^"]*[a-záéíóúñÁÉÍÓÚÑ][^"]*"' src/history/history.js
```
Expected output: only technical/proper-noun literals that were intentionally left untranslated — `"Google Meet"`, `"Asterion"`, file names (`"manifest.json"`, `"transcripcion.json"`, `"transcripcion.txt"`, `"transcripcion.md"`, `"video-reunion.mp4"`, `"video-reunion.webm"`, `"audio-reunion.mp3"`, `"audio-reunion.webm"`), CSS custom property references (`"var(--...)"`), and the `../shared/icons.js` / `../lib/transcript-export.js` import paths. If any other Spanish word-bearing string shows up, it was missed — add it to the key mapping table and translate it before moving on.

- [ ] **Step 6: Commit**

```bash
git add src/history/history.html src/history/history.js src/history/history.test.js
git commit -m "feat: translate history page via i18n module"
```

---

### Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: PASS, all suites green (including the new `src/shared/i18n/i18n.test.js`).

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: succeeds (this feature doesn't touch any of the bundled entry points — content script, webrtc bootstrap, offscreen — so this just confirms nothing else broke).

- [ ] **Step 3: Manual smoke check (report what could and couldn't be verified)**

This step needs a real Chrome instance with `chrome://extensions` → "Load unpacked" pointed at this repo, and changing the browser's display language (`chrome://settings/languages`) between steps — reload the unpacked extension after each language change since `navigator.language` is read once per page load:
1. With Chrome's language set to Spanish (or unset, matching the OS default in most dev setups): open the popup, Settings, and History pages — confirm all text is in Spanish (this is also what step 1's baseline already covers indirectly, since the original strings were Spanish).
2. Switch Chrome's language to English (`en-US`), reload the unpacked extension, reopen all three pages — confirm all text is in English.
3. Switch Chrome's language to French (`fr-FR`), repeat — confirm French text, including the calendar month/weekday names and date formatting in the History page.
4. Switch Chrome's language to an unsupported one, e.g. Portuguese (`pt-BR`), repeat — confirm the pages fall back to English (not blank, not Spanish).
5. In the History page, open a meeting's delete confirmation dialog in each of the three languages and confirm the meeting title is correctly interpolated into the confirmation sentence.

Report explicitly which of these 5 checks were actually run in a browser versus skipped (e.g. if only automated tests were run and no real Chrome session was available).

- [ ] **Step 4: Commit** (only if step 3 required any fixes; otherwise this task produces no code changes to commit)
