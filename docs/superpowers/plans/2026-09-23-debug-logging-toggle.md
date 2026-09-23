# Debug logging detrás de un toggle de configuración — Implementation Plan

> **Para quien ejecute este plan:** este proyecto NO usa `superpowers:subagent-driven-development` ni `superpowers:executing-plans`. Por las reglas del proyecto (`CLAUDE.md`), cada tarea se delega a Codex (agente `codex:codex-rescue`), una por una, referenciando este archivo y el número de tarea exacto. Claude revisa lo que Codex devuelve antes de pasar a la siguiente tarea.

**Goal:** Antes de subir la extensión a la Chrome Web Store, silenciar todos los `console.log`/`console.debug` informativos (prefijos `[Ariadne:debug]`, `[Ariadne:rtc-patch]`, `[Ariadne:audio-mixer]`, `[Ariadne ffmpeg...]`, etc.) salvo que el usuario active explícitamente un toggle "modo debug" en la pantalla de configuración. Los `console.error`/`console.warn` que reportan fallos reales (conversión fallida, error de storage, etc.) quedan siempre visibles — no son "debug", son errores genuinos.

**Inventario exacto (confirmado con grep contra `src/`, sin tests):** 25 líneas de `console.log`/`console.debug` puro-debug en `src/`, repartidas en `meet-detector.js` (6), `meet-caption-observer.js` (7), `bootstrap.js` (8, incluidas las definiciones de `rtcPatchLog` y el logger del mixer), `ffmpeg-client.js` (4). De esas 25, 24 se reemplazan por llamadas gateadas (`debugLog`/`debugDebug`) y 1 se elimina directamente sin reemplazo (el log de "bootstrap cargado" en MAIN world, ver Tarea 6 — corre antes de que el flag pueda llegarle).

**Architecture:** Un módulo puro y minúsculo, `src/shared/debug-log.js`, sin dependencia de `chrome.*`, expone `setDebugEnabled(bool)` / `debugLog(...)` (nivel `console.log`) / `debugDebug(...)` (nivel `console.debug`, para no perder el nivel de verbosidad original de los logs que ya usaban `console.debug`). Cada contexto de JS (ISOLATED `content.bundle.js`, MAIN world `webrtc-bootstrap.bundle.js`, y `offscreen.bundle.js`) lo importa y bundlea su propia copia independiente (son bundles separados vía esbuild, cada uno con su propio estado de módulo — esto es correcto y necesario, ya que MAIN world no comparte memoria JS con ISOLATED ni con offscreen). El toggle se guarda en `chrome.storage.local` bajo la key `debugLogging` (default `false`), igual que `autoStart`/`videoPreset` ya existentes.

- **ISOLATED** (`meet-detector.js`) y **offscreen** (`offscreen.js`) tienen acceso directo a `chrome.storage.local`, así que leen el flag ellos mismos al cargar y llaman `setDebugEnabled(...)`.
- **MAIN world** (`bootstrap.js`) NO tiene acceso a `chrome.*` — el flag le llega dentro del mensaje `asterion:start-session` que ya viaja de ISOLATED a MAIN (se le agrega un campo `debugLogging` más, mismo mecanismo que ya usa `initialMicMuted`).
- `rtc-patch.js`, `audio-mixer.js`, `speaker-observer.js`, `speaker-dom.js`, `session.js` **no se tocan**: ya reciben un callback `log`/`rtcPatchLog` inyectado desde `bootstrap.js` en vez de llamar a `console.*` directamente, así que alcanza con que ese callback llame a `debugDebug`/`debugLog` para que todo lo que pasa por él quede gateado automáticamente.

**Limitación aceptada (revisada por Codex, no se resuelve en este plan):** el mixer y los patches de WebRTC se crean/instalan en MAIN world apenas carga la página (`document_start`), antes de que exista ninguna sesión — pueden emitir logs (ej. configuración inicial del mixer, eventos de conexión WebRTC tempranos) antes de que `asterion:start-session` le traiga el flag desde ISOLATED. Esos logs puntuales nunca se van a poder gatear a `true` con esta arquitectura, incluso con el toggle activado, porque `setDebugEnabled` todavía no se llamó y MAIN world no tiene acceso a `chrome.storage` para leerlo por su cuenta. No vale la pena resolverlo (implicaría, por ejemplo, un mensaje adicional MAIN→ISOLADO→MAIN solo para esto) — la verificación manual (Tarea 8) debe validar logs a partir de `asterion:start-session` en adelante, no antes.

**Tech Stack:** JavaScript vanilla (ES modules), `chrome.storage.local`, Vitest para el módulo puro.

---

### Task 1: `src/shared/debug-log.js` — módulo puro de gating

**Files:**
- Create: `src/shared/debug-log.js`
- Test: `src/shared/debug-log.test.js`

- [ ] **Step 1: Escribir los tests**

```js
// src/shared/debug-log.test.js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugDebug, debugLog, isDebugEnabled, setDebugEnabled } from "./debug-log.js";

describe("debug-log", () => {
  let logSpy;
  let debugSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    setDebugEnabled(false);
  });

  afterEach(() => {
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("is disabled by default", () => {
    expect(isDebugEnabled()).toBe(false);
  });

  it("does not call console.log when disabled", () => {
    debugLog("[Ariadne:debug] hola", { a: 1 });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("calls console.log with the same arguments when enabled", () => {
    setDebugEnabled(true);
    debugLog("[Ariadne:debug] hola", { a: 1 });
    expect(logSpy).toHaveBeenCalledWith("[Ariadne:debug] hola", { a: 1 });
  });

  it("isDebugEnabled reflects the last value set", () => {
    setDebugEnabled(true);
    expect(isDebugEnabled()).toBe(true);
    setDebugEnabled(false);
    expect(isDebugEnabled()).toBe(false);
  });

  it("coerces a truthy/falsy non-boolean value passed to setDebugEnabled", () => {
    setDebugEnabled(1);
    expect(isDebugEnabled()).toBe(true);
    setDebugEnabled(undefined);
    expect(isDebugEnabled()).toBe(false);
  });

  it("debugDebug does not call console.debug when disabled", () => {
    debugDebug("[Ariadne:rtc-patch] evento", { a: 1 });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("debugDebug calls console.debug with the same arguments when enabled", () => {
    setDebugEnabled(true);
    debugDebug("[Ariadne:rtc-patch] evento", { a: 1 });
    expect(debugSpy).toHaveBeenCalledWith("[Ariadne:rtc-patch] evento", { a: 1 });
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run src/shared/debug-log.test.js`
Expected: FAIL (el módulo no existe todavía).

- [ ] **Step 3: Implementar `debug-log.js`**

```js
// src/shared/debug-log.js
// Sin dependencia de chrome.* a propósito: este módulo se bundlea por
// separado en cada contexto (ISOLATED, MAIN world, offscreen) y cada uno
// tiene su propia copia independiente del estado — ver el plan que agregó
// este archivo para el porqué.
let debugEnabled = false;

export function setDebugEnabled(enabled) {
  debugEnabled = Boolean(enabled);
}

export function isDebugEnabled() {
  return debugEnabled;
}

export function debugLog(...args) {
  if (debugEnabled) console.log(...args);
}

export function debugDebug(...args) {
  if (debugEnabled) console.debug(...args);
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/shared/debug-log.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/debug-log.js src/shared/debug-log.test.js
git commit -m "feat: add pure debug-log gate for optional console logging"
```

---

### Task 2: Textos i18n para el nuevo toggle

**Files:**
- Modify: `src/shared/i18n/locales/en.json`
- Modify: `src/shared/i18n/locales/es.json`
- Modify: `src/shared/i18n/locales/fr.json`

- [ ] **Step 1: Agregar las claves nuevas**

En `src/shared/i18n/locales/en.json`, después de la línea `"settings.videoPresetHelper": "..."` (línea 21), agregar:

```json
  "settings.debugLoggingLabel": "Debug logging",
  "settings.debugLoggingHelper": "Prints detailed logs to the browser console while recording. Leave off unless you're troubleshooting an issue.",
```

En `src/shared/i18n/locales/es.json`, en el mismo punto:

```json
  "settings.debugLoggingLabel": "Registro de depuración",
  "settings.debugLoggingHelper": "Imprime logs detallados en la consola del navegador mientras se graba. Dejalo apagado salvo que estés resolviendo un problema.",
```

En `src/shared/i18n/locales/fr.json`, en el mismo punto:

```json
  "settings.debugLoggingLabel": "Journalisation de débogage",
  "settings.debugLoggingHelper": "Affiche des journaux détaillés dans la console du navigateur pendant l'enregistrement. Laissez désactivé sauf en cas de dépannage.",
```

No te olvides de agregar la coma al final de la línea anterior (`videoPresetHelper`) en cada archivo si no la tiene ya (son JSON planos, un objeto por archivo).

- [ ] **Step 2: Correr los tests de i18n para verificar que los tres locales siguen siendo válidos**

Run: `npx vitest run src/shared/i18n/i18n.test.js _locales/messages.test.js`
Expected: PASS (sin cambios de comportamiento esperados, solo confirma que el JSON parsea bien y no rompió nada).

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en.json src/shared/i18n/locales/es.json src/shared/i18n/locales/fr.json
git commit -m "feat: add i18n strings for the debug logging toggle"
```

---

### Task 3: Checkbox de "modo debug" en la pantalla de configuración

**Files:**
- Modify: `src/settings/settings.html`
- Modify: `src/settings/settings.js`

**Contexto:** hoy `settings.html` solo tiene un `<select>` para `videoPreset`, dentro de un único `.setting-card`. Se agrega una segunda `.setting-card` con un checkbox nativo (el repo no tiene ningún `<input type="checkbox">` todavía — el toggle del popup es un `div` con CSS a mano, pero para esta pantalla de settings, más simple, alcanza con un checkbox nativo estilado mínimamente).

- [ ] **Step 1: Agregar el CSS y el HTML del nuevo control**

En `src/settings/settings.html`, agregar este bloque de CSS dentro del `<style>` existente, después de la regla `.helper { ... }` (línea 75-80):

```css
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .checkbox-row label {
        margin-bottom: 0;
      }

      .checkbox-row input[type="checkbox"] {
        width: 18px;
        height: 18px;
        accent-color: var(--accent-blue);
      }
```

Y agregar esta segunda `<section class="setting-card">` dentro de `<main>`, justo después de la sección existente del video preset (después de la línea 103, `</section>`, antes de `</main>`):

```html
      <section class="setting-card">
        <div class="checkbox-row">
          <input type="checkbox" id="debug-logging" />
          <label id="debug-logging-label" for="debug-logging">Registro de depuración</label>
        </div>
        <p id="debug-logging-helper" class="helper">
          Imprime logs detallados en la consola del navegador mientras se graba.
        </p>
      </section>
```

(El texto en español acá es solo un placeholder visual — `settings.js`, en el Step 2, lo sobreescribe con `t("settings.debugLoggingLabel")`/`t("settings.debugLoggingHelper")` en el idioma real del usuario, igual que ya hace con el resto de los textos de esta página.)

- [ ] **Step 2: Leer/escribir el setting en `settings.js`**

En `src/settings/settings.js`, agregar las referencias a los nuevos elementos junto a las que ya existen (línea 8-11):

```js
const videoPresetSelect = document.getElementById("video-preset");
const pageHeadingEl = document.getElementById("page-heading");
const videoPresetLabelEl = document.getElementById("video-preset-label");
const videoPresetHelperEl = document.getElementById("video-preset-helper");
const debugLoggingCheckbox = document.getElementById("debug-logging");
const debugLoggingLabelEl = document.getElementById("debug-logging-label");
const debugLoggingHelperEl = document.getElementById("debug-logging-helper");
```

Agregar la traducción de los textos nuevos junto a las que ya existen (línea 13-17):

```js
debugLoggingLabelEl.textContent = t("settings.debugLoggingLabel");
debugLoggingHelperEl.textContent = t("settings.debugLoggingHelper");
```

Y agregar la lectura/escritura del storage al final del archivo, siguiendo exactamente el mismo patrón que `videoPresetSelect` (línea 28-34):

```js
chrome.storage.local.get({ debugLogging: false }, ({ debugLogging }) => {
  debugLoggingCheckbox.checked = debugLogging;
});

debugLoggingCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ debugLogging: debugLoggingCheckbox.checked });
});
```

- [ ] **Step 3: Verificar manualmente**

No hay test automatizado para `settings.js`/`settings.html` (no lo hay hoy para ningún archivo de `src/settings/` ni `src/popup/`). Abrí `chrome://extensions`, recargá la extensión, abrí el popup, clickeá el ícono de engranaje, y confirmá que aparece el nuevo checkbox "Registro de depuración" con su texto de ayuda, que arranca destildado, y que tildarlo/destildarlo persiste (cerrar y reabrir la página de settings debe recordar el último valor).

- [ ] **Step 4: Commit**

```bash
git add src/settings/settings.html src/settings/settings.js
git commit -m "feat: add debug logging toggle to the settings screen"
```

---

### Task 4: Gatear los logs de `meet-detector.js` (ISOLATED) y propagar el flag a MAIN world

**Files:**
- Modify: `src/content/meet-detector.js`

- [ ] **Step 1: Importar el módulo y leer el flag al cargar**

Agregar el import junto a los que ya existen (línea 1-6):

```js
// src/content/meet-detector.js
import { findByIconText } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { showBanner, showFinishedBanner, updateBannerState } from "./meet-banner.js";
import { arrayBufferToBase64 } from "../lib/base64.js";
import { debugLog, isDebugEnabled, setDebugEnabled } from "../shared/debug-log.js";
```

Reemplazar la línea 8 (`console.log("[Ariadne:debug] content script (ISOLATED) cargado", ...)`) por una promesa que el resto del archivo pueda esperar — `chrome.storage.local.get` es async, y sin esperarla `waitForMeeting()`/`startRecording()` podrían correr antes de que el flag esté seteado (carrera real, señalada por Codex):

```js
const debugLoggingReady = chrome.storage.local.get({ debugLogging: false }).then(({ debugLogging }) => {
  setDebugEnabled(debugLogging);
  debugLog("[Ariadne:debug] content script (ISOLATED) cargado", { url: location.href });
});
```

- [ ] **Step 2: Reemplazar el resto de los `console.log("[Ariadne:debug] ...")` por `debugLog(...)`**

Estas líneas (contenido exacto, solo cambia `console.log` por `debugLog`):

- Línea 60: `console.log("[Ariadne:debug] startRecording iniciado", { sessionId, meetingTitle });` → `debugLog("[Ariadne:debug] startRecording iniciado", { sessionId, meetingTitle });`
- Línea 104: `console.log("[Ariadne:debug] mensaje recibido desde MAIN world", { type: message.type });` → `debugLog(...)` igual.
- Línea 185: `console.log("[Ariadne:debug] waitForMeeting isInActiveMeeting", { isInActiveMeeting: isInActiveMeeting() });` → `debugLog(...)` igual.
- Línea 188: `console.log("[Ariadne:debug] reunión detectada");` → `debugLog(...)` igual.
- Línea 190: `console.log("[Ariadne:debug] autoStart obtenido", { autoStart });` → `debugLog(...)` igual.

**No tocar** la línea 112 (`console.error("[Ariadne] No se pudo iniciar la sesión:", message.reason);`) — es un error real, debe quedar siempre visible.

- [ ] **Step 2.5: Esperar `debugLoggingReady` antes de arrancar `startRecording` y `waitForMeeting`**

Al principio de `async function startRecording()` (línea 54-56), agregar la espera antes de cualquier otra cosa:

```js
async function startRecording() {
  if (sessionId) return;
  await debugLoggingReady;
  sessionId = generateSessionId();
  setState("starting");
```

Y al final del archivo, reemplazar la llamada directa `waitForMeeting();` (última línea) por:

```js
debugLoggingReady.then(waitForMeeting);
```

- [ ] **Step 3: Propagar el flag a MAIN world en `asterion:start-session`**

En el callback de `observeMuteState` (línea 72-84), modificar la línea 77 para incluir el flag:

```js
    if (isFirstMuteReport) {
      isFirstMuteReport = false;
      postToMainWorld({
        type: "asterion:start-session",
        sessionId,
        initialMicMuted: muted,
        debugLogging: isDebugEnabled(),
      });
      return;
    }
```

- [ ] **Step 4: Verificar que el build sigue funcionando**

Run: `npm run build:content`
Expected: termina sin errores y regenera `dist/content.bundle.js`.

- [ ] **Step 5: Commit**

```bash
git add src/content/meet-detector.js
git commit -m "feat: gate meet-detector.js debug logs and forward the flag to MAIN world"
```

---

### Task 5: Gatear los logs de `meet-caption-observer.js`

**Files:**
- Modify: `src/content/meet-caption-observer.js`

Este archivo se bundlea junto con `meet-detector.js` en `content.bundle.js` (mismo grafo de módulos vía `import`), así que comparte la misma instancia de `src/shared/debug-log.js` — no hace falta volver a leer `chrome.storage.local` acá, `setDebugEnabled` ya lo llamó `meet-detector.js`.

- [ ] **Step 1: Importar `debugLog` y reemplazar los 7 `console.log("[Ariadne:debug] ...")`**

Agregar el import (línea 1-2):

```js
// src/content/meet-caption-observer.js
import { SELECTORS } from "./meet-selectors.js";
import { debugLog } from "../shared/debug-log.js";
```

Reemplazar `console.log` por `debugLog` en estas 7 líneas (mismo contenido, solo cambia el nombre de la función):
- Línea 6: `console.log("[Ariadne:debug] findCaptionsContainer — regiones encontradas:", regions.length);`
- Línea 9: `console.log("[Ariadne:debug] findCaptionsContainer — región:", { ... });`
- Línea 22: `console.log("[Ariadne:debug] findCaptionsContainer — ninguna región tenía captionUtteranceBlock");`
- Línea 57: `console.log("[Ariadne:debug] isCaptionsCurrentlyOn — íconos encontrados en el botón:", icons);`
- Línea 60: `console.log("[Ariadne:debug] isCaptionsCurrentlyOn — resultado:", result);`
- Línea 71: `console.log("[Ariadne:debug] ensureCaptionsEnabled — botón encontrado, alreadyOn:", alreadyOn);`
- Línea 74: `console.log("[Ariadne:debug] ensureCaptionsEnabled — click ejecutado");`

- [ ] **Step 2: Verificar que el build sigue funcionando**

Run: `npm run build:content`
Expected: termina sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/content/meet-caption-observer.js
git commit -m "feat: gate meet-caption-observer.js debug logs"
```

---

### Task 6: Gatear los logs de `bootstrap.js` (MAIN world) y recibir el flag

**Files:**
- Modify: `src/webrtc-bootstrap/bootstrap.js`

- [ ] **Step 1: Importar el módulo y quitar el log de carga**

Agregar el import junto a los que ya existen (línea 1-11):

```js
import { startSpeakerObserver } from "./speaker-observer.js";
import { debugDebug, debugLog, setDebugEnabled } from "../shared/debug-log.js";
```

Reemplazar las líneas 13 y 15:

```js
const rtcPatchLog = (event, details) => console.debug(`[Ariadne:rtc-patch] ${event}`, details);

console.log("[Ariadne:debug] bootstrap (MAIN world) cargado");
```

por (nota: se usa `debugDebug`, no `debugLog`, para preservar el nivel `console.debug` original — es un nivel de consola distinto a `console.log`, filtrado aparte en algunas configuraciones de verbosidad de DevTools, y no había motivo para cambiarlo de paso):

```js
const rtcPatchLog = (event, details) => debugDebug(`[Ariadne:rtc-patch] ${event}`, details);
```

(Se elimina el `console.log` de "bootstrap cargado" directamente, sin reemplazo — corre a `document_start`, antes de que exista ninguna sesión y por lo tanto antes de que el flag de debug haya llegado desde ISOLATED vía `asterion:start-session`; no hay forma de gatearlo con este mecanismo, y no vale la pena inventar uno solo para esta línea informativa de bajo valor.)

- [ ] **Step 2: Gatear el logger del mixer**

Línea 18, reemplazar:

```js
  log: (event, details) => console.debug(`[Ariadne:audio-mixer] ${event}`, details),
```

por (mismo motivo que `rtcPatchLog`, `debugDebug` en vez de `debugLog`):

```js
  log: (event, details) => debugDebug(`[Ariadne:audio-mixer] ${event}`, details),
```

- [ ] **Step 3: Gatear el resto de los `console.log` sueltos**

- Línea 80: `console.log("[Ariadne:debug] mensaje recibido desde ISOLATED world", { type: message.type });` → `debugLog(...)` igual.
- Líneas 83-87: el `console.log("[Ariadne:debug] asterion:start-session recibido; ...", {...})` → `debugLog(...)` igual.
- Línea 106: `console.log("[Ariadne] AudioContext state antes de resume():", mixer.audioContext.state);` → `debugLog(...)` igual.
- Línea 108: `console.log("[Ariadne] AudioContext state después de resume():", mixer.audioContext.state);` → `debugLog(...)` igual.
- Línea 143: `console.log("[Ariadne] userActivation.isActive antes de getDisplayMedia:", navigator.userActivation?.isActive);` → `debugLog(...)` igual.

- [ ] **Step 4: Recibir el flag al iniciar sesión**

Al principio del handler de `"asterion:start-session"` (línea 82, antes de la línea que hoy es el primer `console.log` de ese bloque), agregar:

```js
  if (message.type === "asterion:start-session") {
    setDebugEnabled(message.debugLogging);
    debugLog("[Ariadne:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {
      sessionId: message.sessionId,
      mixer,
      session,
    });
```

- [ ] **Step 5: Verificar que el build sigue funcionando**

Run: `npm run build:webrtc`
Expected: termina sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/webrtc-bootstrap/bootstrap.js
git commit -m "feat: gate bootstrap.js (MAIN world) debug logs behind the setting"
```

---

### Task 7: Gatear los logs de `offscreen.js`/`ffmpeg-client.js`

**Files:**
- Modify: `src/offscreen/offscreen.js`
- Modify: `src/offscreen/ffmpeg-client.js`
- Modify: `src/offscreen/ffmpeg-client.test.js` (solo si algún test llega a fallar por el cambio — no se espera, ver Step 3)

Estos dos archivos se bundlean juntos en `offscreen.bundle.js` (`offscreen.js` importa `session-writer.js`, que importa `ffmpeg-client.js`), así que comparten la misma instancia de `debug-log.js`.

- [ ] **Step 1: Leer el flag al cargar `offscreen.js`, y esperarlo antes de procesar mensajes**

`chrome.storage.local.get` es async — sin esperarla, el listener de mensajes podría procesar `asterion:session-starting` (que llega casi inmediatamente después de crearse el offscreen document) antes de que el flag esté seteado. Igual que en la Tarea 4, se expone una promesa `debugLoggingReady` y se la espera al principio del listener:

Reemplazar el principio de `src/offscreen/offscreen.js` (imports + `const sessions = new Map();` + la línea `chrome.runtime.onMessage.addListener((message, sender) => {`) por:

```js
// src/offscreen/offscreen.js
import { SessionWriter } from "../storage/session-writer.js";
import { base64ToArrayBuffer } from "../lib/base64.js";
import { setDebugEnabled } from "../shared/debug-log.js";

const debugLoggingReady = chrome.storage.local
  .get({ debugLogging: false })
  .then(({ debugLogging }) => setDebugEnabled(debugLogging));

const sessions = new Map();

chrome.runtime.onMessage.addListener(async (message, sender) => {
  await debugLoggingReady;
```

(El resto del cuerpo del listener — todos los `if/else if` existentes — no cambia; solo se vuelve `async` la función y se le agrega esa primera línea de espera. No usa `sendResponse` en ningún branch, así que volverla `async` no cambia el comportamiento de mensajería.)

- [ ] **Step 2: Gatear los 4 logs de `ffmpeg-client.js`**

Agregar el import al principio del archivo:

```js
// src/offscreen/ffmpeg-client.js
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { debugLog } from "../shared/debug-log.js";
```

Reemplazar `console.log` por `debugLog` en estas 4 líneas (mismo contenido):
- `console.log(\`[Ariadne ffmpeg:core] ${type}: ${message}\`);` (dentro de `ffmpegInstance.on("log", ...)`)
- `console.log(\`[Ariadne ffmpeg:core] progress=${progress} time=${time}\`);` (dentro de `ffmpegInstance.on("progress", ...)`)
- `console.log(\`[Ariadne ffmpeg] job ${jobId}: iniciando (${inputBytes.byteLength} bytes de entrada)\`);`
- el `console.log` de "terminado en...bytes de salida" al final de `_runJob`

- [ ] **Step 3: Correr los tests existentes para confirmar que no se rompió nada**

Run: `npx vitest run src/offscreen/ffmpeg-client.test.js`
Expected: PASS (1 test) — el test no hace asserts sobre `console.log`, solo sobre el comportamiento de encolado de jobs, así que no debería verse afectado. Si por algún motivo falla, revisar si el test importa algo de `debug-log.js` que necesite un mock (no debería, ya que `debugLog` sin `setDebugEnabled(true)` simplemente no llama a `console.log`).

- [ ] **Step 4: Verificar que el build sigue funcionando**

Run: `npm run build:offscreen`
Expected: termina sin errores.

- [ ] **Step 5: Commit**

Si el Step 3 no requirió tocar `ffmpeg-client.test.js`:

```bash
git add src/offscreen/offscreen.js src/offscreen/ffmpeg-client.js
git commit -m "feat: gate offscreen.js/ffmpeg-client.js debug logs"
```

Si sí lo requirió, incluir también ese archivo en el mismo commit:

```bash
git add src/offscreen/offscreen.js src/offscreen/ffmpeg-client.js src/offscreen/ffmpeg-client.test.js
git commit -m "feat: gate offscreen.js/ffmpeg-client.js debug logs"
```

---

### Task 8: Verificación final

**Files:** ninguno.

- [ ] **Step 1: Correr toda la suite**

Run: `npx vitest run`
Expected: PASS en todos los archivos existentes más `src/shared/debug-log.test.js` (único archivo de test nuevo de esta feature).

- [ ] **Step 2: Build completo**

Run: `npm run build`
Expected: termina sin errores.

- [ ] **Step 3: Verificación manual — logs apagados por defecto**

Recargar la extensión en `chrome://extensions`, abrir una reunión de Meet, abrir DevTools en esa pestaña, grabar unos segundos. Confirmar que **no** aparece ningún log con prefijo `[Ariadne:debug]`, `[Ariadne:rtc-patch]`, `[Ariadne:audio-mixer]`, `[Ariadne ffmpeg` — pero que si algo falla de verdad (ej. desconectar el micrófono para forzar un error), el `console.error` correspondiente sigue apareciendo.

- [ ] **Step 4: Verificación manual — logs encendidos con el toggle**

Ir a la pantalla de configuración, activar "Registro de depuración", recargar la pestaña de Meet, grabar unos segundos. Confirmar que ahora sí aparecen los logs con esos prefijos, en la consola de la pestaña de Meet y en la del offscreen document (`chrome://extensions` → "Inspeccionar" en la vista del offscreen document).

**Importante:** el checkbox no tiene efecto en vivo sobre una grabación ya en curso — ISOLATED y offscreen leen el flag una sola vez al cargar, y MAIN world lo recibe una sola vez al iniciar sesión (`asterion:start-session`). Cambiar el toggle mientras se está grabando no hace nada hasta la próxima vez que se recargue la pestaña de Meet (o el offscreen document) y se inicie una sesión nueva. Esto es un comportamiento aceptado para este plan, no un bug — si en el futuro se quiere que el cambio se refleje sin recargar, haría falta un listener de `chrome.storage.onChanged`, que queda fuera de alcance acá.

- [ ] **Step 5: Reportar** qué se verificó con éxito y qué no se pudo probar (ej. si no había forma de forzar un error real para confirmar que los `console.error` siguen visibles).
