# Asterion — Prototipo de Captura (Fase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensión de Chrome MV3 que, para una sola pestaña de Google Meet, detecta la reunión, permite iniciar la grabación manualmente, y captura localmente transcripción, audio de la reunión, audio propio (excluyendo períodos muteados) y video opcional, dejando todo organizado en una carpeta local por reunión.

**Architecture:** Service worker como plano de control (detección + orquestación), un único offscreen document como plano de medios (tabCapture + MediaRecorder + mic, con passthrough de audio a `AudioContext.destination` para no silenciar la pestaña), y un content script por pestaña de Meet como plano de observación (estado de mute, subtítulos vía `MutationObserver`). El almacenamiento usa File System Access API: el directorio raíz se elige una vez desde el popup (contexto con gesto de usuario) y el handle se persiste en IndexedDB para que el offscreen document escriba sin nuevos prompts. En este plan la escritura ocurre una vez al finalizar la reunión, desde blobs acumulados en memoria durante la sesión — no es streaming incremental en tiempo real (ver nota de alcance en el Task 13).

**Tech Stack:** JavaScript vanilla (sin framework), Manifest V3, `chrome.tabCapture`, `chrome.offscreen`, `MediaRecorder`, `MutationObserver`, File System Access API, IndexedDB, Vitest + jsdom para lógica pura.

**Fuera de alcance de este plan:** historial multi-reunión con UI navegable (PRD 5.7), aislamiento entre reuniones concurrentes (PRD 5.5), adaptador de subida por webhook (PRD sección 7). Este plan cubre una sola reunión de inicio a fin; esos puntos son planes de seguimiento una vez validada la captura.

**Revisión de Codex incorporada (2026-09-13):** este plan fue revisado por Codex (`gpt-5.6-terra`, esfuerzo medio) antes de ejecutarse, por regla de [CLAUDE.md](../../../CLAUDE.md). Cambios aplicados como resultado:

1. Los content scripts de MV3 no soportan imports ES module de forma nativa vía `manifest.json` — se agregó un Task 1.5 con `esbuild` para bundlear `src/content/*.js` a un único archivo IIFE antes de cargar la extensión.
2. Se agregó permiso `"activeTab"` al manifest (requerido por `chrome.tabCapture.getMediaStreamId` cuando el flujo se dispara desde una acción del usuario en la propia página, no desde el popup).
3. Se corrigió un test roto en el Task 3 (el segundo `onSnapshot` de "Ana" faltaba, dejando un `startMs` inconsistente).
4. Se agregó un Task 5.5 de descubrimiento de DOM real de Meet — los selectores `aria-label`/clases usados en los Tasks 6-8 son hipótesis a confirmar contra el DOM real, no hechos verificados, y ahora viven en un módulo de selectores centralizado y documentado en vez de estar hardcodeados e implícitamente confiables.
5. Se agregó un protocolo mínimo de arranque de sesión (Tasks 6 y 9) para evitar perder el primer evento de mute/caption si llega antes de que el offscreen document termine de crear la sesión, y se serializó la creación del offscreen document para evitar una condición de carrera si dos reuniones inician casi al mismo tiempo.
6. Se implementó de verdad el toggle de video por reunión (antes hardcodeado a `false`), y se agregó verificación de permiso de escritura (`queryPermission`) antes de escribir en el Task 13, con mensaje claro si hay que reautorizar desde el popup.
7. Se ajustó la redacción del Task 13: los archivos se escriben al finalizar la reunión desde blobs acumulados en memoria durante la sesión — no es escritura incremental a disco en tiempo real. Streaming incremental real (necesario para reuniones de varias horas) queda documentado como trabajo de seguimiento explícito, no implícito.
8. Se agregó auto-detención si el usuario cierra la pestaña de Meet mientras graba (`chrome.tabs.onRemoved`), y una guarda simple contra doble inicio de grabación en la misma pestaña.

Codex también señaló que `MediaRecorder.pause()/resume()` no garantiza de forma determinista, a nivel de contenedor/muxer, que la duración final del archivo sea exactamente la suma de los períodos desmuteados — el Task 11 ahora incluye una verificación explícita de esa duración como criterio de aceptación, no como supuesto.

---

## File Structure

```
asterion/
  package.json
  vitest.config.js
  manifest.json
  src/
    lib/
      mute-manifest.js         # lógica pura: eventos mute/unmute -> intervalos
      mute-manifest.test.js
      caption-parser.js        # lógica pura: mutaciones de captions -> segmentos finales
      caption-parser.test.js
    content/
      meet-selectors.js        # selectores DOM de Meet centralizados y documentados (Task 5.5)
      meet-detector.js         # entrypoint del content script
      meet-banner.js           # banner "reunión detectada" + botón iniciar (+ toggle de video)
      meet-mute-observer.js    # observa el botón de mic de Meet, emite eventos
      meet-caption-observer.js # observa el contenedor de captions, emite mutaciones
  dist/
    content.bundle.js          # generado por esbuild (Task 1.5) a partir de src/content/
    background/
      service-worker.js        # plano de control
    offscreen/
      offscreen.html
      offscreen.js             # entrypoint del offscreen document
      session.js               # una sesión de grabación (recorders + gating de mic)
    storage/
      directory-handle-store.js # persistencia del handle de directorio en IndexedDB
      directory-writer.js       # escritura a disco por reunión (todo en memoria hasta el stop, ver Task 13)
    popup/
      popup.html
      popup.js                 # elegir carpeta raíz (una vez)
  docs/
    superpowers/plans/2026-09-13-meet-capture-prototype.md
```

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `manifest.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "asterion",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "build:content": "esbuild src/content/meet-detector.js --bundle --outfile=dist/content.bundle.js"
  },
  "devDependencies": {
    "esbuild": "^0.24.0",
    "jsdom": "^25.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `vitest.config.js`**

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
  },
});
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 4: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Asterion — Captura de Reuniones",
  "version": "0.1.0",
  "description": "Captura local de transcripción, audio y video de reuniones de Google Meet.",
  "minimum_chrome_version": "116",
  "permissions": ["tabCapture", "offscreen", "storage", "activeTab", "scripting"],
  "host_permissions": ["https://meet.google.com/*"],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["dist/content.bundle.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "src/popup/popup.html"
  }
}
```

Nota: `js` en `content_scripts` apunta a `dist/content.bundle.js` (generado en el Task 1.5), no a `src/content/meet-detector.js` directamente — Chrome no resuelve imports ES module dentro de un content script declarado en el manifest, así que el archivo fuente con `import` fallaría en tiempo de carga sin este bundling.

- [ ] **Step 5: Commit**

```bash
git init
git add package.json vitest.config.js manifest.json
git commit -m "chore: scaffold Asterion extension project"
```

---

## Task 1.5: Build tooling para el content script

Resuelve el hallazgo de Codex: los content scripts declarados en `manifest.json` no soportan `import`/`export` sin un bundler — se compila `src/content/meet-detector.js` (y todo lo que importa) a un único archivo con `esbuild`.

**Files:**
- Modify: `package.json` (ya tiene el script `build:content` desde el Task 1)
- Create: `dist/` (generado, no se versiona)
- Modify: `.gitignore`

- [ ] **Step 1: Install esbuild**

Run: `npm install`
Expected: `esbuild` aparece en `node_modules/.bin/esbuild`.

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 3: Run the build (se ejecutará de nuevo al final de cada tarea que toque `src/content/`)**

Run: `npm run build:content`
Expected: se crea `dist/content.bundle.js` sin errores.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: bundle content scripts with esbuild"
```

**Nota para el resto del plan:** cada vez que un Task modifique algo bajo `src/content/`, correr `npm run build:content` y recargar la extensión (`chrome://extensions` → botón de recarga) antes de la verificación manual de ese Task. Los pasos de verificación manual de los Tasks 5.5-8 y 13 asumen que este build ya corrió.

## Task 2: Mute-interval manifest logic

Esto resuelve el requerimiento 5.3 (excluir silencios reales, no grabarlos) sin perder la línea de tiempo real: en vez de intentar razonar sobre el archivo de audio ya recortado, guardamos los intervalos reales en un manifiesto separado.

**Files:**
- Create: `src/lib/mute-manifest.js`
- Test: `src/lib/mute-manifest.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/mute-manifest.test.js
import { describe, expect, it } from "vitest";
import { MuteManifest } from "./mute-manifest.js";

describe("MuteManifest", () => {
  it("starts with no unmuted intervals", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    expect(m.toJSON().intervals).toEqual([]);
  });

  it("records one unmuted interval when unmuted then muted", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onUnmuted(1500);
    m.onMuted(2500);
    expect(m.toJSON().intervals).toEqual([{ startMs: 500, endMs: 1500 }]);
  });

  it("closes an open interval at finalize time", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onUnmuted(1500);
    m.finalize(3000);
    expect(m.toJSON().intervals).toEqual([{ startMs: 500, endMs: 2000 }]);
  });

  it("ignores a duplicate onUnmuted while already unmuted", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onUnmuted(1500);
    m.onUnmuted(1800);
    m.onMuted(2000);
    expect(m.toJSON().intervals).toEqual([{ startMs: 500, endMs: 1000 }]);
  });

  it("ignores a duplicate onMuted while already muted", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onMuted(1500);
    expect(m.toJSON().intervals).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mute-manifest`
Expected: FAIL — `Cannot find module './mute-manifest.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/mute-manifest.js
export class MuteManifest {
  constructor({ startedAt }) {
    this.startedAt = startedAt;
    this.intervals = [];
    this.openIntervalStartMs = null;
  }

  onUnmuted(timestampMs) {
    if (this.openIntervalStartMs !== null) return;
    this.openIntervalStartMs = timestampMs - this.startedAt;
  }

  onMuted(timestampMs) {
    if (this.openIntervalStartMs === null) return;
    this.intervals.push({
      startMs: this.openIntervalStartMs,
      endMs: timestampMs - this.startedAt,
    });
    this.openIntervalStartMs = null;
  }

  finalize(timestampMs) {
    if (this.openIntervalStartMs !== null) {
      this.onMuted(timestampMs);
    }
  }

  toJSON() {
    return { intervals: this.intervals };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mute-manifest`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mute-manifest.js src/lib/mute-manifest.test.js
git commit -m "feat: add mute-interval manifest logic"
```

---

## Task 3: Caption parser logic

Resuelve 5.1: convertir las mutaciones crudas del panel de captions de Meet (que se reescriben mientras el texto se "estabiliza") en segmentos finales de transcripción con hablante y texto.

**Files:**
- Create: `src/lib/caption-parser.js`
- Test: `src/lib/caption-parser.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/caption-parser.test.js
import { describe, expect, it } from "vitest";
import { CaptionParser } from "./caption-parser.js";

describe("CaptionParser", () => {
  it("emits nothing while the same speaker keeps updating text", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.onSnapshot({ speaker: "Ana", text: "Hola a todos", timestampMs: 400 });
    expect(parser.finishedSegments).toEqual([]);
  });

  it("finalizes the previous speaker's segment when the speaker changes", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.onSnapshot({ speaker: "Ana", text: "Hola a todos", timestampMs: 400 });
    parser.onSnapshot({ speaker: "Beto", text: "Hola Ana", timestampMs: 900 });
    expect(parser.finishedSegments).toEqual([
      { speaker: "Ana", text: "Hola a todos", startMs: 100, endMs: 400 },
    ]);
  });

  it("ignores a snapshot identical to the current one (no-op)", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 150 });
    parser.finalizeCurrent(200);
    expect(parser.finishedSegments).toEqual([
      { speaker: "Ana", text: "Hola", startMs: 100, endMs: 200 },
    ]);
  });

  it("uses 'unknown' when no speaker is available", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: null, text: "algo", timestampMs: 100 });
    parser.finalizeCurrent(200);
    expect(parser.finishedSegments).toEqual([
      { speaker: "unknown", text: "algo", startMs: 100, endMs: 200 },
    ]);
  });

  it("finalizeCurrent closes an in-progress segment", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.finalizeCurrent(1000);
    expect(parser.finishedSegments).toEqual([
      { speaker: "Ana", text: "Hola", startMs: 100, endMs: 1000 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- caption-parser`
Expected: FAIL — `Cannot find module './caption-parser.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/caption-parser.js
const UNKNOWN_SPEAKER = "unknown";

export class CaptionParser {
  constructor() {
    this.finishedSegments = [];
    this.current = null;
  }

  onSnapshot({ speaker, text, timestampMs }) {
    const normalizedSpeaker = speaker ?? UNKNOWN_SPEAKER;

    if (this.current && this.current.speaker === normalizedSpeaker) {
      this.current.text = text;
      this.current.endMs = timestampMs;
      return;
    }

    if (this.current) {
      this._finishCurrent();
    }

    this.current = {
      speaker: normalizedSpeaker,
      text,
      startMs: timestampMs,
      endMs: timestampMs,
    };
  }

  finalizeCurrent(timestampMs) {
    if (!this.current) return;
    this.current.endMs = timestampMs;
    this._finishCurrent();
  }

  _finishCurrent() {
    const { speaker, text, startMs, endMs } = this.current;
    this.finishedSegments.push({ speaker, text, startMs, endMs });
    this.current = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- caption-parser`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/caption-parser.js src/lib/caption-parser.test.js
git commit -m "feat: add caption parser logic"
```

---

## Task 4: Directory handle persistence

Resuelve la parte de 5.6 que necesita gesto de usuario: elegir la carpeta raíz una sola vez, desde el popup, y guardar el handle para que el offscreen document lo reutilice sin pedir permisos de nuevo.

**Files:**
- Create: `src/storage/directory-handle-store.js`

- [ ] **Step 1: Write `directory-handle-store.js`**

```js
// src/storage/directory-handle-store.js
const DB_NAME = "asterion";
const STORE_NAME = "handles";
const HANDLE_KEY = "rootDirectory";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRootDirectoryHandle(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadRootDirectoryHandle() {
  const db = await openDb();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}
```

- [ ] **Step 2: Manual verification (no automated test — File System Access + IndexedDB handle storage require a real browser context)**

En la consola de una página de extensión (por ejemplo el popup, abierto con DevTools):

```js
import { saveRootDirectoryHandle, loadRootDirectoryHandle } from "./directory-handle-store.js";
const handle = await window.showDirectoryPicker();
await saveRootDirectoryHandle(handle);
const loaded = await loadRootDirectoryHandle();
console.log(loaded.name === handle.name); // true
```

Expected: `true` en consola, y el picker de carpetas del sistema operativo se abrió una sola vez.

- [ ] **Step 3: Commit**

```bash
git add src/storage/directory-handle-store.js
git commit -m "feat: persist chosen root directory handle in IndexedDB"
```

---

## Task 5: Popup — elegir carpeta raíz

**Files:**
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.js`

- [ ] **Step 1: Write `popup.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Asterion</title>
  </head>
  <body>
    <button id="choose-folder">Elegir carpeta de grabaciones</button>
    <p id="status"></p>
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `popup.js`**

```js
// src/popup/popup.js
import { saveRootDirectoryHandle, loadRootDirectoryHandle } from "../storage/directory-handle-store.js";

const statusEl = document.getElementById("status");
const buttonEl = document.getElementById("choose-folder");

async function refreshStatus() {
  const handle = await loadRootDirectoryHandle();
  statusEl.textContent = handle
    ? `Carpeta actual: ${handle.name}`
    : "Ninguna carpeta elegida todavía.";
}

buttonEl.addEventListener("click", async () => {
  const handle = await window.showDirectoryPicker();
  await handle.requestPermission({ mode: "readwrite" });
  await saveRootDirectoryHandle(handle);
  await refreshStatus();
});

refreshStatus();
```

- [ ] **Step 3: Manual verification**

Cargar la extensión sin empaquetar (`chrome://extensions` → Cargar descomprimida), abrir el popup, hacer clic en "Elegir carpeta de grabaciones", elegir una carpeta.
Expected: el texto cambia a `Carpeta actual: <nombre>`. Cerrar y volver a abrir el popup debe seguir mostrando esa carpeta (persistencia confirmada).

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.html src/popup/popup.js
git commit -m "feat: add popup to choose root recordings directory"
```

---

## Task 5.5: Descubrimiento de selectores DOM reales de Meet

Codex marcó como riesgo alto que los selectores `aria-label` de los Tasks 6-8 eran hipótesis presentadas con demasiada confianza. Antes de construir los observadores, hay que confirmarlos contra el DOM real y centralizarlos en un solo módulo — así, cuando Meet cambie su interfaz, el ajuste es en un lugar, no disperso en tres archivos.

**Files:**
- Create: `src/content/meet-selectors.js`

- [ ] **Step 1: Inspeccionar el DOM real de Meet**

Entrar a una reunión real de Meet (puede ser en solitario), abrir DevTools → Inspeccionar, y confirmar, anotando el idioma de la interfaz usada:
- El elemento que solo existe dentro de una llamada activa (candidato: botón de colgar).
- El botón de silenciar/activar micrófono y qué atributo refleja su estado (`aria-pressed`, `data-is-muted`, una clase CSS específica — no asumir `data-is-muted` sin confirmarlo).
- El botón para activar subtítulos, y el contenedor donde aparece el texto una vez activados, incluyendo si tarda en montarse tras el clic.
- Dentro del contenedor de subtítulos, qué nodo trae el nombre del hablante y cuál el texto de la intervención.

- [ ] **Step 2: Write `meet-selectors.js` con lo confirmado**

```js
// src/content/meet-selectors.js
// Selectores confirmados a mano contra el DOM real de Meet (ver Task 5.5, Step 1).
// Son best-effort: Meet no expone una API estable para esto y puede cambiar
// su estructura o sus aria-label localizados sin previo aviso (riesgo
// documentado en asterion-alcance.md, sección 6). Si algo deja de funcionar,
// este es el único archivo que hay que revisar.
export const SELECTORS = {
  hangUpButton: '[aria-label="Salir de la llamada"]',
  micButton: '[aria-label*="micrófono"]',
  micMutedAttribute: "data-is-muted",
  captionsToggleButton: '[aria-label="Activar subtítulos"]',
  captionsContainer: '[aria-label="Subtítulos"]',
  captionSpeakerName: ".speaker-name",
  captionText: ".caption-text",
};
```

- [ ] **Step 3: Manual verification**

Confirmar en la consola de DevTools, dentro de una reunión real con subtítulos activados, que cada selector de `SELECTORS` devuelve un elemento no nulo:

```js
Object.entries(SELECTORS).forEach(([key, value]) => {
  if (key.endsWith("Attribute")) return;
  console.log(key, document.querySelector(value));
});
```

Expected: ningún `null` en la consola. Si algún selector no encuentra nada, corregirlo en `meet-selectors.js` antes de seguir — los Tasks 6-8 importan de este archivo, así que un selector equivocado aquí rompe todo lo que sigue.

- [ ] **Step 4: Commit**

```bash
git add src/content/meet-selectors.js
git commit -m "chore: centralize confirmed Meet DOM selectors"
```

---

## Task 6: Content script — detección de reunión y banner de inicio manual

Resuelve 5.8: detectar reunión activa y advertir al usuario, sin iniciar grabación automáticamente.

**Files:**
- Create: `src/content/meet-banner.js`
- Create: `src/content/meet-detector.js`

- [ ] **Step 1: Write `meet-banner.js`**

```js
// src/content/meet-banner.js
export function showStartBanner(onStartClicked) {
  if (document.getElementById("asterion-banner")) return;

  const banner = document.createElement("div");
  banner.id = "asterion-banner";
  banner.style.position = "fixed";
  banner.style.bottom = "16px";
  banner.style.right = "16px";
  banner.style.zIndex = "999999";
  banner.style.background = "#202124";
  banner.style.color = "#fff";
  banner.style.padding = "12px 16px";
  banner.style.borderRadius = "8px";
  banner.style.fontFamily = "sans-serif";
  banner.style.fontSize = "14px";

  const label = document.createElement("span");
  label.textContent = "Reunión detectada. ";
  banner.appendChild(label);

  const videoLabel = document.createElement("label");
  videoLabel.style.marginLeft = "8px";
  const videoCheckbox = document.createElement("input");
  videoCheckbox.type = "checkbox";
  videoLabel.appendChild(videoCheckbox);
  videoLabel.appendChild(document.createTextNode(" Incluir video"));
  banner.appendChild(videoLabel);

  const button = document.createElement("button");
  button.textContent = "Iniciar grabación";
  button.style.marginLeft = "8px";
  button.addEventListener("click", () => {
    onStartClicked({ captureVideo: videoCheckbox.checked });
    banner.remove();
  });
  banner.appendChild(button);

  document.body.appendChild(banner);
}
```

- [ ] **Step 2: Write `meet-detector.js`**

```js
// src/content/meet-detector.js
import { showStartBanner } from "./meet-banner.js";
import { SELECTORS } from "./meet-selectors.js";

function isInActiveMeeting() {
  return document.querySelector(SELECTORS.hangUpButton) !== null;
}

let recordingStarted = false;

function startRecording({ captureVideo }) {
  if (recordingStarted) return;
  recordingStarted = true;
  chrome.runtime.sendMessage({ type: "asterion:start-recording", captureVideo });
}

function waitForMeeting() {
  const observer = new MutationObserver(() => {
    if (isInActiveMeeting()) {
      observer.disconnect();
      showStartBanner(startRecording);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

waitForMeeting();
```

La guarda `recordingStarted` evita que un doble clic (o una re-ejecución del `MutationObserver`) dispare dos sesiones para la misma pestaña.

- [ ] **Step 3: Manual verification**

Correr `npm run build:content`, recargar la extensión, entrar a una reunión real de Meet (puede ser en solitario con un enlace propio).
Expected: aparece el banner "Reunión detectada." con el checkbox "Incluir video" y el botón "Iniciar grabación" abajo a la derecha en cuanto se entra a la llamada. El selector `SELECTORS.hangUpButton` viene del Task 5.5 — si no encontró nada ahí, corregir en `meet-selectors.js`, no aquí.

- [ ] **Step 4: Commit**

```bash
npm run build:content
git add src/content/meet-banner.js src/content/meet-detector.js
git commit -m "feat: detect active Meet call and show manual start banner"
```

(`dist/` está en `.gitignore` desde el Task 1.5 — no se versiona, se regenera con `npm run build:content`.)

---

## Task 7: Content script — observador de mute

Resuelve la parte de detección de 5.3 (saber cuándo el mic del usuario está activo dentro de Meet).

**Files:**
- Modify: `src/content/meet-detector.js`
- Create: `src/content/meet-mute-observer.js`

- [ ] **Step 1: Write `meet-mute-observer.js`**

```js
// src/content/meet-mute-observer.js
import { SELECTORS } from "./meet-selectors.js";

function isMicButtonMuted(button) {
  return button.getAttribute(SELECTORS.micMutedAttribute) === "true";
}

export function observeMuteState(onChange) {
  const micButton = document.querySelector(SELECTORS.micButton);
  if (!micButton) return () => {};

  let lastMuted = isMicButtonMuted(micButton);
  onChange(lastMuted, Date.now());

  const observer = new MutationObserver(() => {
    const muted = isMicButtonMuted(micButton);
    if (muted !== lastMuted) {
      lastMuted = muted;
      onChange(muted, Date.now());
    }
  });

  observer.observe(micButton, { attributes: true });
  return () => observer.disconnect();
}
```

- [ ] **Step 2: Modify `meet-detector.js` to wire the mute observer with an event queue**

Codex señaló que el primer evento de mute puede llegar antes de que el offscreen document termine de crear la sesión (Task 9), y se perdería. En vez de enviar los eventos directo, se guardan en una cola local hasta recibir el ack `asterion:session-ready` que manda el service worker una vez que la sesión ya existe en el offscreen document.

```js
// src/content/meet-detector.js
import { showStartBanner } from "./meet-banner.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { SELECTORS } from "./meet-selectors.js";

function isInActiveMeeting() {
  return document.querySelector(SELECTORS.hangUpButton) !== null;
}

let recordingStarted = false;
let sessionReady = false;
const pendingMessages = [];

function sendSessionMessage(message) {
  if (sessionReady) {
    chrome.runtime.sendMessage(message);
  } else {
    pendingMessages.push(message);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:session-ready") {
    sessionReady = true;
    pendingMessages.forEach((queued) => chrome.runtime.sendMessage(queued));
    pendingMessages.length = 0;
  }
});

function startRecording({ captureVideo }) {
  if (recordingStarted) return;
  recordingStarted = true;
  chrome.runtime.sendMessage({ type: "asterion:start-recording", captureVideo });

  observeMuteState((muted, timestampMs) => {
    sendSessionMessage({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });
}

function waitForMeeting() {
  const observer = new MutationObserver(() => {
    if (isInActiveMeeting()) {
      observer.disconnect();
      showStartBanner(startRecording);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

waitForMeeting();
```

- [ ] **Step 3: Manual verification**

Correr `npm run build:content`, recargar la extensión, entrar a una reunión, iniciar grabación desde el banner, mutear y desmutear el micrófono un par de veces.
Expected: usando la pestaña "Service worker" en `chrome://extensions`, se ven mensajes `asterion:mic-muted` / `asterion:mic-unmuted` llegando después del `asterion:session-ready` (verificar con `console.log` temporal en el listener del Task 9 — que en este punto del plan todavía no reenvía el ack real; eso se conecta en el Task 9). El atributo confirmado en `meet-selectors.js` (Task 5.5) es el que se usa acá — si algo no dispara, revisar ese archivo, no este.

- [ ] **Step 4: Commit**

```bash
npm run build:content
git add src/content/meet-mute-observer.js src/content/meet-detector.js
git commit -m "feat: observe Meet mic mute state and queue events until session ready"
```

---

## Task 8: Content script — observador de captions

Resuelve 5.1: conectar el DOM real de subtítulos con `CaptionParser` (Task 3).

**Files:**
- Modify: `src/content/meet-detector.js`
- Create: `src/content/meet-caption-observer.js`

- [ ] **Step 1: Write `meet-caption-observer.js`**

```js
// src/content/meet-caption-observer.js
import { SELECTORS } from "./meet-selectors.js";

function findCaptionsContainer() {
  return document.querySelector(SELECTORS.captionsContainer);
}

function readCurrentSnapshot(container) {
  const speakerEl = container.querySelector(SELECTORS.captionSpeakerName) ?? null;
  const textEl = container.querySelector(SELECTORS.captionText);
  if (!textEl) return null;

  return {
    speaker: speakerEl ? speakerEl.textContent.trim() : null,
    text: textEl.textContent.trim(),
    timestampMs: Date.now(),
  };
}

export function observeCaptions(onSnapshot) {
  const container = findCaptionsContainer();
  if (!container) return () => {};

  const observer = new MutationObserver(() => {
    const snapshot = readCurrentSnapshot(container);
    if (snapshot) onSnapshot(snapshot);
  });

  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

export function enableCaptionsAndObserve(onSnapshot, { retries = 10, delayMs = 300 } = {}) {
  if (findCaptionsContainer()) {
    return observeCaptions(onSnapshot);
  }

  document.querySelector(SELECTORS.captionsToggleButton)?.click();

  let attemptsLeft = retries;
  let cleanup = () => {};

  const tryAttach = () => {
    const container = findCaptionsContainer();
    if (container) {
      cleanup = observeCaptions(onSnapshot);
      return;
    }
    attemptsLeft -= 1;
    if (attemptsLeft > 0) setTimeout(tryAttach, delayMs);
  };
  tryAttach();

  return () => cleanup();
}
```

El contenedor de subtítulos puede montarse de forma asíncrona tras el clic — `enableCaptionsAndObserve` reintenta en vez de asumir que ya existe justo después del clic (gap señalado por Codex en el Task 8 original).

- [ ] **Step 2: Modify `meet-detector.js` to wire captions through the same event queue**

```js
// src/content/meet-detector.js
import { showStartBanner } from "./meet-banner.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { SELECTORS } from "./meet-selectors.js";

function isInActiveMeeting() {
  return document.querySelector(SELECTORS.hangUpButton) !== null;
}

let recordingStarted = false;
let sessionReady = false;
const pendingMessages = [];

function sendSessionMessage(message) {
  if (sessionReady) {
    chrome.runtime.sendMessage(message);
  } else {
    pendingMessages.push(message);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:session-ready") {
    sessionReady = true;
    pendingMessages.forEach((queued) => chrome.runtime.sendMessage(queued));
    pendingMessages.length = 0;
  }
});

function startRecording({ captureVideo }) {
  if (recordingStarted) return;
  recordingStarted = true;
  chrome.runtime.sendMessage({ type: "asterion:start-recording", captureVideo });

  observeMuteState((muted, timestampMs) => {
    sendSessionMessage({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });

  enableCaptionsAndObserve((snapshot) => {
    sendSessionMessage({ type: "asterion:caption-snapshot", snapshot });
  });
}

function waitForMeeting() {
  const observer = new MutationObserver(() => {
    if (isInActiveMeeting()) {
      observer.disconnect();
      showStartBanner(startRecording);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

waitForMeeting();
```

- [ ] **Step 3: Manual verification**

Correr `npm run build:content`, recargar la extensión, iniciar grabación en una reunión real donde alguien hable (puede ser una prueba en solitario narrando en voz alta).
Expected: mensajes `asterion:caption-snapshot` llegan al service worker con `text` cambiando progresivamente, incluso si los subtítulos tardan un momento en aparecer tras activarse. Los selectores vienen de `meet-selectors.js` (Task 5.5) — si algo no coincide, ajustar ahí.

- [ ] **Step 4: Commit**

```bash
npm run build:content
git add src/content/meet-caption-observer.js src/content/meet-detector.js
git commit -m "feat: observe Meet captions and forward snapshots through session queue"
```

---

## Task 9: Service worker — plano de control

Resuelve el arranque de `tabCapture` (requiere gesto de usuario, ya satisfecho por el click en el banner) y la creación del offscreen document.

**Files:**
- Create: `src/background/service-worker.js`

- [ ] **Step 1: Write `service-worker.js`**

```js
// src/background/service-worker.js
const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const activeTabIds = new Set();
let offscreenCreationPromise = null;

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;

  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification: "Grabar audio/video de una pestaña de Google Meet y el micrófono del usuario.",
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }
  await offscreenCreationPromise;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "asterion:session-started") {
    chrome.tabs.sendMessage(message.tabId, { type: "asterion:session-ready" });
    return;
  }

  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (message.type === "asterion:start-recording") {
    handleStartRecording(tabId, message.captureVideo);
    return;
  }

  if (message.type === "asterion:stop-recording") {
    handleStopRecording(tabId);
    return;
  }

  if (
    message.type === "asterion:mic-muted" ||
    message.type === "asterion:mic-unmuted" ||
    message.type === "asterion:caption-snapshot"
  ) {
    chrome.runtime.sendMessage({ ...message, tabId });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabIds.has(tabId)) {
    handleStopRecording(tabId);
  }
});

async function handleStartRecording(tabId, captureVideo) {
  if (activeTabIds.has(tabId)) return;
  activeTabIds.add(tabId);

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  chrome.runtime.sendMessage({ type: "asterion:begin-session", tabId, streamId, captureVideo });
}

async function handleStopRecording(tabId) {
  if (!activeTabIds.has(tabId)) return;
  activeTabIds.delete(tabId);

  chrome.runtime.sendMessage({ type: "asterion:stop-session", tabId });

  if (activeTabIds.size === 0) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}
```

`activeTabIds` cumple dos roles: evita iniciar dos sesiones para la misma pestaña (doble clic, mensaje duplicado) y decide cuándo ya no queda ninguna sesión activa para cerrar el offscreen document. `offscreenCreationPromise` serializa la creación — sin esto, dos reuniones iniciando casi al mismo tiempo podían ambas ver "no existe todavía" y llamar `createDocument()` dos veces, lo cual falla porque solo se permite un offscreen document por extensión.

- [ ] **Step 2: Manual verification**

En `chrome://extensions`, abrir la vista "Service worker" de Asterion. Iniciar grabación desde el banner en Meet.
Expected: log sin errores; `chrome.offscreen.createDocument` se ejecuta una sola vez aunque se inicien varias reuniones (verificar reabriendo una segunda pestaña de Meet e iniciando grabación ahí también — no debe lanzar error de "solo un offscreen document permitido"). Cerrar la pestaña de Meet mientras se grababa también debe disparar `handleStopRecording` (verificar en el Task 13 que efectivamente escribe los archivos).

- [ ] **Step 3: Commit**

```bash
git add src/background/service-worker.js
git commit -m "feat: add service worker control plane for recording sessions"
```

---

## Task 10: Offscreen — sesión de grabación (audio de pestaña + video opcional + passthrough)

Resuelve 5.2 y 5.4, y el riesgo de que `tabCapture` corte el audio local de la pestaña.

**Files:**
- Create: `src/offscreen/session.js`

- [ ] **Step 1: Write `session.js` (tab audio/video + local playback passthrough)**

```js
// src/offscreen/session.js
export class RecordingSession {
  constructor({ tabId, streamId, captureVideo }) {
    this.tabId = tabId;
    this.streamId = streamId;
    this.captureVideo = captureVideo;
    this.chunks = { tab: [], mic: [] };
    this.captionSegments = [];
  }

  async start() {
    this.tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: this.streamId } },
      video: this.captureVideo
        ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: this.streamId } }
        : false,
    });

    this._passthroughAudioToSpeakers(this.tabStream);

    this.tabRecorder = new MediaRecorder(this.tabStream, {
      mimeType: this.captureVideo ? "video/webm" : "audio/webm",
    });
    this.tabRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.tab.push(event.data);
    };
    this.tabRecorder.start(1000);
  }

  _passthroughAudioToSpeakers(stream) {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);
    this.audioContext = audioContext;
  }

  async stop() {
    this.tabRecorder?.stop();
    await new Promise((resolve) => {
      if (!this.tabRecorder) return resolve();
      this.tabRecorder.onstop = resolve;
    });
    this.tabStream?.getTracks().forEach((track) => track.stop());
    await this.audioContext?.close();
  }

  getTabBlob() {
    return new Blob(this.chunks.tab, { type: this.captureVideo ? "video/webm" : "audio/webm" });
  }
}
```

- [ ] **Step 2: Write `offscreen.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    <script type="module" src="offscreen.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Write minimal `offscreen.js` wiring one session**

```js
// src/offscreen/offscreen.js
import { RecordingSession } from "./session.js";

const sessions = new Map();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:begin-session") {
    handleBeginSession(message);
  }
});

async function handleBeginSession({ tabId, streamId }) {
  const session = new RecordingSession({ tabId, streamId, captureVideo: false });
  sessions.set(tabId, session);
  await session.start();
}
```

- [ ] **Step 4: Manual verification**

Iniciar grabación en una reunión real de Meet con al menos otra persona hablando (o un video de prueba reproduciéndose en otra pestaña que comparta pantalla).
Expected: el audio de la reunión sigue escuchándose con normalidad en los parlantes (passthrough funcionando — sin esto, `tabCapture` deja la pestaña muda). No debe haber errores en la consola del offscreen document (`chrome://extensions` → inspeccionar vistas → offscreen.html).

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/session.js src/offscreen/offscreen.html src/offscreen/offscreen.js
git commit -m "feat: capture tab audio/video with local playback passthrough"
```

---

## Task 11: Offscreen — mic propio con gating de mute

Resuelve 5.3 completo: el `MediaRecorder` del mic se pausa/reanuda según los eventos reales de mute, y se alimenta el `MuteManifest` del Task 2.

**Files:**
- Modify: `src/offscreen/session.js`
- Modify: `src/offscreen/offscreen.js`

- [ ] **Step 1: Extend `session.js` with mic capture and mute gating**

```js
// src/offscreen/session.js
import { MuteManifest } from "../lib/mute-manifest.js";

export class RecordingSession {
  constructor({ tabId, streamId, captureVideo }) {
    this.tabId = tabId;
    this.streamId = streamId;
    this.captureVideo = captureVideo;
    this.chunks = { tab: [], mic: [] };
    this.captionSegments = [];
    this.muteManifest = new MuteManifest({ startedAt: Date.now() });
  }

  async start() {
    this.tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: this.streamId } },
      video: this.captureVideo
        ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: this.streamId } }
        : false,
    });
    this._passthroughAudioToSpeakers(this.tabStream);

    this.tabRecorder = new MediaRecorder(this.tabStream, {
      mimeType: this.captureVideo ? "video/webm" : "audio/webm",
    });
    this.tabRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.tab.push(event.data);
    };
    this.tabRecorder.start(1000);

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.micRecorder = new MediaRecorder(this.micStream, { mimeType: "audio/webm" });
    this.micRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.mic.push(event.data);
    };
    this.micRecorder.start(1000);
    this.micRecorder.pause();
  }

  onMicMuted(timestampMs) {
    this.muteManifest.onMuted(timestampMs);
    if (this.micRecorder?.state === "recording") this.micRecorder.pause();
  }

  onMicUnmuted(timestampMs) {
    this.muteManifest.onUnmuted(timestampMs);
    if (this.micRecorder?.state === "paused") this.micRecorder.resume();
  }

  _passthroughAudioToSpeakers(stream) {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);
    this.audioContext = audioContext;
  }

  async stop() {
    this.muteManifest.finalize(Date.now());
    this.tabRecorder?.stop();
    this.micRecorder?.stop();
    await Promise.all([
      new Promise((resolve) => {
        if (!this.tabRecorder) return resolve();
        this.tabRecorder.onstop = resolve;
      }),
      new Promise((resolve) => {
        if (!this.micRecorder) return resolve();
        this.micRecorder.onstop = resolve;
      }),
    ]);
    this.tabStream?.getTracks().forEach((track) => track.stop());
    this.micStream?.getTracks().forEach((track) => track.stop());
    await this.audioContext?.close();
  }

  getTabBlob() {
    return new Blob(this.chunks.tab, { type: this.captureVideo ? "video/webm" : "audio/webm" });
  }

  getMicBlob() {
    return new Blob(this.chunks.mic, { type: "audio/webm" });
  }

  getMuteManifestJSON() {
    return this.muteManifest.toJSON();
  }
}
```

- [ ] **Step 2: Wire mute events in `offscreen.js`**

```js
// src/offscreen/offscreen.js
import { RecordingSession } from "./session.js";

const sessions = new Map();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:begin-session") {
    handleBeginSession(message);
  } else if (message.type === "asterion:mic-muted") {
    sessions.get(message.tabId)?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    sessions.get(message.tabId)?.onMicUnmuted(message.timestampMs);
  }
});

async function handleBeginSession({ tabId, streamId, captureVideo }) {
  const session = new RecordingSession({ tabId, streamId, captureVideo: Boolean(captureVideo) });
  sessions.set(tabId, session);
  await session.start();
  chrome.runtime.sendMessage({ type: "asterion:session-started", tabId });
}
```

`session.start()` se espera por completo (incluyendo el arranque del `MediaRecorder` del mic) antes de avisar `asterion:session-started` — así el service worker (Task 9) solo reenvía `asterion:session-ready` al content script cuando ya hay algo del otro lado escuchando eventos de mute/captions, cerrando el hueco de carrera que señaló Codex.

- [ ] **Step 3: Manual verification — criterio de aceptación de la duración del audio propio**

Iniciar grabación, hablar unos segundos desmuteado, mutear, esperar unos segundos, desmutear y hablar de nuevo, luego detener manualmente desde la consola del offscreen document con `sessions.get(<tabId>).stop()` seguido de descargar el blob (`URL.createObjectURL(session.getMicBlob())` y abrirlo en una pestaña).

Expected — verificación explícita, no asumida (Codex señaló que `pause()`/`resume()` no garantiza a nivel de contenedor/muxer que la duración final sea exactamente la suma de los tramos desmuteados):
1. Reproducir el archivo resultante y cronometrar su duración total con un reloj.
2. Sumar a mano los intervalos de `session.getMuteManifestJSON().intervals` (en milisegundos) y convertir a segundos.
3. Ambas duraciones deben coincidir dentro de un margen de ±1 segundo. Si difieren más que eso, el enfoque de `pause()`/`resume()` no es suficiente y hay que registrarlo como bloqueante antes de seguir — la alternativa de respaldo (fuera de este plan) es grabar segmentos separados por tramo desmuteado y concatenarlos en la escritura final.

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/session.js src/offscreen/offscreen.js
git commit -m "feat: gate mic recording by real mute state and track mute manifest"
```

---

## Task 12: Offscreen — captions acumuladas por sesión

**Files:**
- Modify: `src/offscreen/session.js`
- Modify: `src/offscreen/offscreen.js`

- [ ] **Step 1: Extend `session.js` to own a `CaptionParser`**

```js
// src/offscreen/session.js (agregar al constructor y agregar métodos)
import { CaptionParser } from "../lib/caption-parser.js";

// dentro del constructor:
//   this.captionParser = new CaptionParser();

// nuevo método:
//   onCaptionSnapshot(snapshot) {
//     this.captionParser.onSnapshot(snapshot);
//   }

// dentro de stop(), antes de resolver:
//   this.captionParser.finalizeCurrent(Date.now());

// nuevo getter:
//   getTranscriptText() {
//     return this.captionParser.finishedSegments
//       .map((segment) => `[${segment.speaker}] ${segment.text}`)
//       .join("\n");
//   }
```

Aplicar estos cambios directamente sobre `src/offscreen/session.js` del Task 11: agregar el import, inicializar `this.captionParser = new CaptionParser();` en el constructor, agregar el método `onCaptionSnapshot`, llamar `this.captionParser.finalizeCurrent(Date.now());` al inicio de `stop()`, y agregar el getter `getTranscriptText()`.

- [ ] **Step 2: Wire caption snapshots in `offscreen.js`**

```js
// src/offscreen/offscreen.js — agregar rama al listener existente
else if (message.type === "asterion:caption-snapshot") {
  sessions.get(message.tabId)?.onCaptionSnapshot(message.snapshot);
}
```

- [ ] **Step 3: Manual verification**

Repetir la verificación manual del Task 8 (captions llegando) con una sesión activa, y al finalizar correr en la consola del offscreen document `sessions.get(<tabId>).getTranscriptText()`.
Expected: texto legible con formato `[hablante] texto`, un renglón por intervención, sin duplicados de las correcciones intermedias de Meet.

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/session.js src/offscreen/offscreen.js
git commit -m "feat: accumulate caption segments per session"
```

---

## Task 13: Escritura a disco al finalizar la sesión

Resuelve 5.6 (organización local) y el cierre completo del flujo: al detener, se escriben `audio-reunion.webm`, `audio-propio.webm`, `transcripcion.txt` y `manifest.json` en una subcarpeta por reunión. **Nota de alcance (aportada por la revisión de Codex):** esto escribe los archivos completos una sola vez al finalizar, a partir de los blobs acumulados en memoria durante toda la sesión (Tasks 10-11) — no es streaming incremental a disco durante la grabación. Para una reunión corta de prueba esto es aceptable; para sesiones de varias horas, acumular todo en memoria es un riesgo real de memoria y de pérdida total de datos ante un crash, y streaming incremental de verdad queda como trabajo de seguimiento explícito (ver Self-Review Notes).

**Files:**
- Create: `src/storage/directory-writer.js`
- Modify: `src/offscreen/offscreen.js`

- [ ] **Step 1: Write `directory-writer.js`**

```js
// src/storage/directory-writer.js
import { loadRootDirectoryHandle } from "./directory-handle-store.js";

function meetingFolderName(startedAt) {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `reunion-${iso}`;
}

export async function writeSessionOutput({ startedAt, tabBlob, micBlob, transcriptText, muteManifest, captureVideo }) {
  const rootHandle = await loadRootDirectoryHandle();
  if (!rootHandle) {
    throw new Error("No hay carpeta raíz configurada. Ábrela desde el popup de la extensión.");
  }

  const permission = await rootHandle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error(
      "El permiso de escritura sobre la carpeta raíz ya no está activo. Abrí el popup de la extensión y volvé a elegir la carpeta para renovarlo."
    );
  }

  const meetingHandle = await rootHandle.getDirectoryHandle(meetingFolderName(startedAt), {
    create: true,
  });

  await writeFile(meetingHandle, captureVideo ? "audio-video-reunion.webm" : "audio-reunion.webm", tabBlob);
  await writeFile(meetingHandle, "audio-propio.webm", micBlob);
  await writeFile(meetingHandle, "transcripcion.txt", new Blob([transcriptText], { type: "text/plain" }));
  await writeFile(
    meetingHandle,
    "manifest.json",
    new Blob([JSON.stringify({ startedAt, muteManifest }, null, 2)], { type: "application/json" })
  );
}

async function writeFile(directoryHandle, name, blob) {
  const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}
```

- [ ] **Step 2: Wire stop + write in `offscreen.js`**

```js
// src/offscreen/offscreen.js
import { RecordingSession } from "./session.js";
import { writeSessionOutput } from "../storage/directory-writer.js";

const sessions = new Map();
const startedAtByTabId = new Map();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:begin-session") {
    handleBeginSession(message);
  } else if (message.type === "asterion:mic-muted") {
    sessions.get(message.tabId)?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    sessions.get(message.tabId)?.onMicUnmuted(message.timestampMs);
  } else if (message.type === "asterion:caption-snapshot") {
    sessions.get(message.tabId)?.onCaptionSnapshot(message.snapshot);
  } else if (message.type === "asterion:stop-session") {
    handleStopSession(message.tabId);
  }
});

async function handleBeginSession({ tabId, streamId, captureVideo }) {
  const session = new RecordingSession({ tabId, streamId, captureVideo: Boolean(captureVideo) });
  sessions.set(tabId, session);
  startedAtByTabId.set(tabId, Date.now());
  await session.start();
  chrome.runtime.sendMessage({ type: "asterion:session-started", tabId });
}

async function handleStopSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;

  await session.stop();
  try {
    await writeSessionOutput({
      startedAt: startedAtByTabId.get(tabId),
      tabBlob: session.getTabBlob(),
      micBlob: session.getMicBlob(),
      transcriptText: session.getTranscriptText(),
      muteManifest: session.getMuteManifestJSON(),
      captureVideo: session.captureVideo,
    });
  } catch (error) {
    console.error("Asterion: fallo al escribir la grabación", error);
  }

  sessions.delete(tabId);
  startedAtByTabId.delete(tabId);
}
```

Nota: si `writeSessionOutput` falla (por ejemplo por el permiso de la carpeta raíz revocado), el error queda logueado en la consola del offscreen document pero los blobs ya están en memoria de la función — para este prototipo es aceptable perderlos si eso ocurre; recuperación robusta ante fallos de escritura queda fuera de alcance de este plan (ver Self-Review Notes).

- [ ] **Step 3: Add a stop control to the banner (minimal: a second banner after start)**

```js
// src/content/meet-detector.js — agregar tras startRecording() dentro de la función que maneja el click
// (agregar tras las líneas de observeMuteState/observeCaptions en startRecording)
function showStopBanner() {
  const banner = document.createElement("div");
  banner.id = "asterion-stop-banner";
  banner.style.position = "fixed";
  banner.style.bottom = "16px";
  banner.style.right = "16px";
  banner.style.zIndex = "999999";
  banner.style.background = "#8c1d18";
  banner.style.color = "#fff";
  banner.style.padding = "12px 16px";
  banner.style.borderRadius = "8px";
  banner.style.fontFamily = "sans-serif";
  banner.style.fontSize = "14px";
  banner.style.cursor = "pointer";
  banner.textContent = "Detener grabación";
  banner.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "asterion:stop-recording" });
    banner.remove();
  });
  document.body.appendChild(banner);
}
```

Y agregar `showStopBanner();` como última línea dentro de `startRecording()`. El listener de `"asterion:stop-recording"` en `service-worker.js` ya existe desde el Task 9 (`handleStopRecording`), que a su vez reenvía `asterion:stop-session` al offscreen document — no hace falta agregarlo de nuevo aquí.

- [ ] **Step 4: Manual verification — flujo completo de punta a punta**

1. Elegir carpeta raíz desde el popup (Task 5).
2. Entrar a una reunión real de Meet.
3. Clic en "Iniciar grabación" en el banner.
4. Hablar desmuteado, mutear, hablar de nuevo desmuteado (para validar Task 11), dejar que alguien más hable para generar captions (Task 12).
5. Clic en "Detener grabación".

Expected: en la carpeta raíz elegida aparece una subcarpeta `reunion-<timestamp>` con `audio-reunion.webm` (o `audio-video-reunion.webm` si se marcó "Incluir video" en el banner del Task 6), `audio-propio.webm`, `transcripcion.txt` y `manifest.json`. `audio-propio.webm` reproduce solo los tramos desmuteados (con la duración validada en el Task 11). `transcripcion.txt` tiene el texto por hablante. `manifest.json` tiene `intervals` con los tramos reales de mute. Cerrar la pestaña de Meet en pleno arranque de la grabación (en vez de usar el botón "Detener") también debe producir estos mismos archivos, gracias al `chrome.tabs.onRemoved` del Task 9.

- [ ] **Step 5: Commit**

```bash
npm run build:content
git add src/storage/directory-writer.js src/offscreen/offscreen.js src/content/meet-detector.js
git commit -m "feat: write session output to local directory and add stop control"
```

---

## Self-Review Notes

- **Cobertura del PRD (fase 1):** 5.1 (Task 5.5, 8, 12), 5.2 (Task 10), 5.3 (Task 7, 11), 5.4 — video opcional real vía el checkbox del banner (Task 6) pasado como `captureVideo` de punta a punta hasta `RecordingSession`, 5.6 (Task 4, 5, 13), 5.8 (Task 6). 5.5 (aislamiento multi-reunión) y 5.7 (historial) quedan explícitamente fuera (ver cabecera del plan).
- **Fixes aplicados tras la revisión de Codex** (detalle completo en la nota "Revisión de Codex incorporada" al inicio del documento): bundling de content scripts (Task 1.5), permiso `activeTab`, test roto del Task 3, módulo de selectores centralizado (Task 5.5), protocolo de arranque con cola de eventos + ack `session-ready` (Tasks 6-9, 11, 13), serialización de creación del offscreen document y cierre cuando no quedan sesiones (Task 9), auto-detención al cerrar la pestaña (Task 9), verificación de permiso de escritura antes de guardar (Task 13), criterio de aceptación explícito para la duración del audio propio (Task 11).
- **Riesgos que siguen abiertos y quedan como trabajo de seguimiento explícito, no implícito:** (a) los selectores de `meet-selectors.js` quedan confirmados contra una sesión real puntual (Task 5.5) pero Meet puede cambiarlos sin aviso — es mantenimiento continuo, no algo que se resuelva una vez; (b) los blobs de audio/video se acumulan enteros en memoria durante toda la reunión y solo se escriben al finalizar (Task 13) — sesiones de varias horas necesitan streaming incremental real a disco, no implementado en este plan; (c) no hay recuperación ante un crash del offscreen document o del navegador durante una grabación en curso — se pierde la sesión completa; (d) si dos reuniones están simultáneamente desmuteadas, ambas grabarán la misma señal física del micrófono (limitación de plataforma, no de este plan, y de todos modos fuera del alcance de fase 1 según 5.5).
- **Consistencia de tipos:** `RecordingSession` expone `getTabBlob()`, `getMicBlob()`, `getMuteManifestJSON()`, `getTranscriptText()`, `onMicMuted()`, `onMicUnmuted()`, `onCaptionSnapshot()`, `start()`, `stop()` — usados de forma consistente en `offscreen.js` desde el Task 9 en adelante. El campo `captureVideo` viaja sin transformaciones desde el checkbox del banner (Task 6) → mensaje `start-recording` → `handleStartRecording` (Task 9) → mensaje `begin-session` → `RecordingSession` (Task 11) → nombre de archivo en `directory-writer.js` (Task 13).
