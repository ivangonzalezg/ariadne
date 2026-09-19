# Transcript JSON Storage Implementation Plan

> **Proceso de ejecución (este proyecto):** Claude orquesta y revisa; Codex (agente `codex:codex-rescue`) ejecuta cada tarea tal como está escrita — test primero, implementación, verificación, commit — y reporta qué verificó y qué no. Este plan fue diseñado consultando a Codex sobre la arquitectura y luego revisado por Codex completo (arquitectura/tareas/riesgos); los hallazgos de esa revisión ya están incorporados (ver "Revisión de Codex incorporada" al final del documento). Listo para ejecutar la Task 1.

**Goal:** Reemplazar el archivo de transcripción plano (`transcripcion.txt`) por un archivo JSON estructurado (`transcripcion.json`) con un array de segmentos en camelCase, y agregar opciones de descarga como TXT y Markdown generadas a partir de ese JSON.

**Architecture:** `CaptionParser` ya produce en memoria `finishedSegments: {speaker, text, startMs, endMs}[]` — no cambia. `SessionWriter.finalize()` transforma esos segmentos a `{index, startTime, endTime, text, speaker}` (timestamps en ms relativos a `startedAt`, sin `speaker_id` porque no hay diarización real) y los escribe como `transcripcion.json` en vez de aplanarlos a texto. `history.js` deja de re-parsear texto con regex: lee el JSON directamente para renderizar la lista de intervenciones, y nuevas funciones puras en `src/lib/transcript-export.js` generan las versiones TXT/Markdown bajo demanda para los botones de descarga. No hay soporte para transcripciones viejas en `.txt` — decisión de producto del usuario: el proyecto es nuevo, no hace falta migración ni lectura dual.

**Tech Stack:** JavaScript vanilla (sin framework), Vitest para tests, Chrome Extension APIs (OPFS, `chrome.downloads`).

---

### Task 1: Funciones puras de exportación de transcripción (TXT y Markdown)

**Files:**
- Create: `src/lib/transcript-export.js`
- Test: `src/lib/transcript-export.test.js`

- [ ] **Step 1: Escribir el test que falla**

```js
// src/lib/transcript-export.test.js
import { describe, expect, it } from "vitest";
import { formatSegmentTimestamp, transcriptToTxt, transcriptToMarkdown } from "./transcript-export.js";

const segments = [
  { index: 0, startTime: 0, endTime: 4000, text: "Hola a todos", speaker: "Ana" },
  { index: 1, startTime: 75000, endTime: 80000, text: "Buenas", speaker: "Luis" },
];

describe("formatSegmentTimestamp", () => {
  it("formats milliseconds as mm:ss", () => {
    expect(formatSegmentTimestamp(0)).toBe("00:00");
    expect(formatSegmentTimestamp(75000)).toBe("01:15");
  });
});

describe("transcriptToTxt", () => {
  it("renders one bracketed line per segment", () => {
    expect(transcriptToTxt(segments)).toBe("[00:00] [Ana] Hola a todos\n[01:15] [Luis] Buenas");
  });

  it("returns an empty string for no segments", () => {
    expect(transcriptToTxt([])).toBe("");
  });

  it("collapses internal line breaks so each segment stays on one line", () => {
    const withNewlines = [{ index: 0, startTime: 0, endTime: 1000, text: "Primera línea\nsegunda línea", speaker: "Ana" }];
    expect(transcriptToTxt(withNewlines)).toBe("[00:00] [Ana] Primera línea segunda línea");
  });
});

describe("transcriptToMarkdown", () => {
  it("renders a heading and a bold speaker block per segment", () => {
    expect(transcriptToMarkdown(segments, "Daily sync")).toBe(
      "# Daily sync\n\n**Ana** _[00:00]_\nHola a todos\n\n**Luis** _[01:15]_\nBuenas\n"
    );
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/lib/transcript-export.test.js`
Expected: FAIL con `Cannot find module './transcript-export.js'` (el archivo todavía no existe).

- [ ] **Step 3: Implementar `src/lib/transcript-export.js`**

```js
// src/lib/transcript-export.js
export function formatSegmentTimestamp(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function transcriptToTxt(segments) {
  return segments
    .map((segment) => `[${formatSegmentTimestamp(segment.startTime)}] [${segment.speaker}] ${segment.text.replace(/\s*\n+\s*/g, " ").trim()}`)
    .join("\n");
}

export function transcriptToMarkdown(segments, meetingTitle) {
  const heading = `# ${meetingTitle}\n\n`;
  const body = segments
    .map((segment) => `**${segment.speaker}** _[${formatSegmentTimestamp(segment.startTime)}]_\n${segment.text}`)
    .join("\n\n");
  return `${heading}${body}\n`;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/lib/transcript-export.test.js`
Expected: PASS (5 tests)

Nota: `transcriptToTxt` normaliza saltos de línea internos con `.replace(/\s*\n+\s*/g, " ")` — si un segmento trae texto multilínea (poco común, pero `meet-caption-observer.js` sólo hace `.trim()` en los extremos, no dentro del texto), igual queda en una sola línea con el formato `[mm:ss] [speaker] texto`, sin romper el contrato de "una línea por segmento" que también usa `history.js` para descargas.

- [ ] **Step 5: Commit**

```bash
git add src/lib/transcript-export.js src/lib/transcript-export.test.js
git commit -m "feat: add pure transcript-to-txt/markdown export helpers"
```

---

### Task 2: `SessionWriter` escribe `transcripcion.json` en vez de `transcripcion.txt`

**Files:**
- Modify: `src/storage/session-writer.js:19-24` (eliminar `formatTimestamp`, ya no se usa)
- Modify: `src/storage/session-writer.js:92` (usar `this.endedAt` en vez de `Date.now()` al cerrar el último segmento)
- Modify: `src/storage/session-writer.js:100-112` (escribir JSON en vez de texto plano)
- Test: `src/storage/session-writer.test.js`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `describe("SessionWriter conversion flow", ...)` en `src/storage/session-writer.test.js`, antes del cierre del `describe`:

```js
  it("writes transcripcion.json with camelCase segments relative to startedAt", async () => {
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    writer.onCaptionSnapshot({ speaker: "Ana", text: "Hola", timestampMs: writer.startedAt + 1000 });
    writer.onCaptionSnapshot({ speaker: "Luis", text: "Hola de vuelta", timestampMs: writer.startedAt + 5000 });

    const endedAt = writer.startedAt + 8000;
    await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
    await finished;

    const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
    const segments = JSON.parse(new TextDecoder().decode(bytes));

    expect(segments).toEqual([
      { index: 0, startTime: 1000, endTime: 1000, text: "Hola", speaker: "Ana" },
      { index: 1, startTime: 5000, endTime: 8000, text: "Hola de vuelta", speaker: "Luis" },
    ]);
  });

  it("collapses consecutive snapshots from the same speaker into one segment", async () => {
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    writer.onCaptionSnapshot({ speaker: "Ana", text: "Hola", timestampMs: writer.startedAt + 1000 });
    writer.onCaptionSnapshot({ speaker: "Ana", text: "Hola a todos", timestampMs: writer.startedAt + 2000 });
    writer.onCaptionSnapshot({ speaker: "Luis", text: "Buenas", timestampMs: writer.startedAt + 5000 });

    const endedAt = writer.startedAt + 6000;
    await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
    await finished;

    const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
    const segments = JSON.parse(new TextDecoder().decode(bytes));

    expect(segments).toEqual([
      { index: 0, startTime: 1000, endTime: 2000, text: "Hola a todos", speaker: "Ana" },
      { index: 1, startTime: 5000, endTime: 6000, text: "Buenas", speaker: "Luis" },
    ]);
  });

  it("does not write any transcript file when there were no captions", async () => {
    ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
    const writer = await createWriter({ audio: true, video: false });
    const finished = finishConversions(writer);

    await writer.finalize({ muteManifest: { intervals: [] } });
    await finished;

    expect(writer.meetingHandle.files.has("transcripcion.json")).toBe(false);
  });
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: FAIL — el primer test nuevo falla porque `transcripcion.json` no existe (se sigue escribiendo `transcripcion.txt`) y/o porque `endTime` del último segmento no coincide (hoy usa `Date.now()` en vez de `endedAt`).

- [ ] **Step 3: Implementar el cambio en `session-writer.js`**

Eliminar la función `formatTimestamp` (líneas 19-24, ya no tiene otros usos en el archivo):

```js
// ELIMINAR este bloque completo:
function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
```

En `finalize()`, cambiar la línea que cierra el segmento en curso para usar `this.endedAt` (ya calculado dos líneas antes) en vez de `Date.now()`:

```js
// Antes:
    this.captionParser.finalizeCurrent(Date.now());

// Después:
    this.captionParser.finalizeCurrent(this.endedAt);
```

Reemplazar el bloque que escribe `transcripcion.txt` (dentro de `if (this.hasCaption) { ... }`) por:

```js
    if (this.hasCaption) {
      // segment.startMs/endMs son epoch absoluto (Date.now() en meet-caption-observer.js);
      // se restan contra startedAt para guardar offsets relativos al inicio de la
      // grabación, iguales a los que usa el resto del manifest.
      const segments = this.captionParser.finishedSegments.map((segment, index) => ({
        index,
        startTime: segment.startMs - this.startedAt,
        endTime: segment.endMs - this.startedAt,
        text: segment.text,
        speaker: segment.speaker,
      }));
      const fileHandle = await this.meetingHandle.getFileHandle("transcripcion.json", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(segments, null, 2));
      await writable.close();
    }
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: PASS (todos los tests del archivo, incluidos los 4 preexistentes y los 2 nuevos)

- [ ] **Step 5: Commit**

```bash
git add src/storage/session-writer.js src/storage/session-writer.test.js
git commit -m "feat: persist transcript as camelCase JSON instead of plain text"
```

---

### Task 3: `history.js` lee y renderiza el JSON, y agrega descarga TXT/Markdown

**Files:**
- Modify: `src/history/history.js:1` (nuevo import)
- Modify: `src/history/history.js:227` (leer `transcripcion.json`)
- Modify: `src/history/history.js:235` (eliminar `parseTranscript`)
- Modify: `src/history/history.js:236-246` (`createFileFooter`: nuevo parámetro `meeting` + botones TXT/Markdown)
- Modify: `src/history/history.js:284-287` (`renderTabContent`: renderizar `activeFile.value` directo)
- Modify: `src/history/history.js:300` (pasar `meeting` a `createFileFooter`)
- Modify: `src/history/history.html:41` (permitir que `.detail-file-actions` haga wrap con 4 botones en vez de 2)

No hay test automatizado para `history.js` en este repo (es DOM puro sin test unitario existente) — la verificación de esta tarea es manual, según el paso 6.

- [ ] **Step 1: Agregar el import de los helpers de exportación**

Al inicio del archivo, junto al import existente de `icon`:

```js
// Antes:
import { icon } from "../shared/icons.js";

// Después:
import { icon } from "../shared/icons.js";
import { formatSegmentTimestamp, transcriptToTxt, transcriptToMarkdown } from "../lib/transcript-export.js";
```

Nota: se importa también `formatSegmentTimestamp` (no `formatMediaTime`, que ya existe en este archivo para audio/video) porque `formatMediaTime(0)` devuelve `"0:00"` mientras que el formato de transcripción — tanto el viejo `parseTranscript` como los nuevos `transcriptToTxt`/`transcriptToMarkdown` — usa `"00:00"` con cero a la izquierda en los minutos. Usar `formatSegmentTimestamp` en el Step 4 mantiene el mismo formato visual que tenía la transcripción antes de este cambio.

- [ ] **Step 2: Leer `transcripcion.json` en vez de `transcripcion.txt`**

```js
// Antes:
  if (tab === "transcript") { const file = await (await directory.getFileHandle("transcripcion.txt")).getFile(); return { file, name: "transcripcion.txt", text: await file.text() }; }

// Después:
  if (tab === "transcript") { const file = await (await directory.getFileHandle("transcripcion.json")).getFile(); return { file, name: "transcripcion.json", value: JSON.parse(await file.text()) }; }
```

- [ ] **Step 3: Eliminar `parseTranscript` (ya no hace falta re-parsear texto)**

```js
// ELIMINAR esta línea completa:
function parseTranscript(text) { return text.split("\n").map((line) => line.match(/^\[(\d+:\d{2})\] \[(.*?)\] (.*)$/)).filter(Boolean).map((match) => ({ timestamp: match[1], speaker: match[2], text: match[3] })); }
```

- [ ] **Step 4: Renderizar los segmentos del JSON directamente en `renderTabContent`**

```js
// Antes:
function renderTabContent(content, activeFile) {
  if (state.selectedTab === "transcript") {
    const list = document.createElement("div"); list.className = "transcript-list";
    parseTranscript(activeFile.text).forEach((entry) => { const row = document.createElement("div"); row.className = "transcript-row"; const timestamp = document.createElement("time"); timestamp.className = "transcript-time"; timestamp.textContent = entry.timestamp; const spoken = document.createElement("p"); spoken.className = "transcript-spoken"; const speaker = document.createElement("strong"); speaker.textContent = entry.speaker; spoken.append(speaker, document.createTextNode(` ${entry.text}`)); row.append(timestamp, spoken); list.appendChild(row); });
    if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "detail-empty"; empty.textContent = "No se encontraron intervenciones en la transcripción."; content.appendChild(empty); } else content.appendChild(list);

// Después:
function renderTabContent(content, activeFile) {
  if (state.selectedTab === "transcript") {
    const list = document.createElement("div"); list.className = "transcript-list";
    activeFile.value.forEach((segment) => { const row = document.createElement("div"); row.className = "transcript-row"; const timestamp = document.createElement("time"); timestamp.className = "transcript-time"; timestamp.textContent = formatSegmentTimestamp(segment.startTime); const spoken = document.createElement("p"); spoken.className = "transcript-spoken"; const speaker = document.createElement("strong"); speaker.textContent = segment.speaker; spoken.append(speaker, document.createTextNode(` ${segment.text}`)); row.append(timestamp, spoken); list.appendChild(row); });
    if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "detail-empty"; empty.textContent = "No se encontraron intervenciones en la transcripción."; content.appendChild(empty); } else content.appendChild(list);
```

(la línea siguiente, con el `else content.appendChild(list);` y el cierre del `if`, no cambia)

- [ ] **Step 5: Agregar botones de descarga TXT/Markdown en `createFileFooter`**

```js
// Antes:
function createFileFooter(activeFile) {
  const footer = document.createElement("footer"); footer.className = "detail-footer";
  const fileRow = document.createElement("div"); fileRow.className = "detail-file-row";
  const metadata = document.createElement("div"); metadata.className = "detail-file-meta"; const name = document.createElement("span"); name.className = "detail-file-name"; name.textContent = activeFile.name; const size = document.createElement("span"); size.className = "detail-file-size"; size.textContent = formatFileSize(activeFile.file.size); metadata.append(name, size);
  const actions = document.createElement("div"); actions.className = "detail-file-actions";
  const view = document.createElement("button"); view.type = "button"; view.className = "detail-action"; view.innerHTML = `${icon("external-link", { size: 12, color: "currentColor" })}<span>Abrir</span>`; view.addEventListener("click", () => viewFile(activeFile.file));
  const download = document.createElement("button"); download.type = "button"; download.className = "detail-action"; download.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>Descargar</span>`; download.addEventListener("click", () => downloadFile(activeFile.file, activeFile.name));
  const separator = document.createElement("span"); separator.className = "detail-footer-separator"; separator.setAttribute("aria-hidden", "true");
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-meeting-button"; remove.innerHTML = `${icon("trash-2", { size: 14, color: "currentColor" })}<span>Eliminar reunión</span>`; remove.addEventListener("click", () => showDeleteDialog(state.meetings.find((item) => meetingId(item) === state.selectedMeetingId), remove));
  actions.append(view, download); fileRow.append(metadata, actions); footer.append(fileRow, separator, remove); return footer;
}

// Después:
function createFileFooter(activeFile, meeting) {
  const footer = document.createElement("footer"); footer.className = "detail-footer";
  const fileRow = document.createElement("div"); fileRow.className = "detail-file-row";
  const metadata = document.createElement("div"); metadata.className = "detail-file-meta"; const name = document.createElement("span"); name.className = "detail-file-name"; name.textContent = activeFile.name; const size = document.createElement("span"); size.className = "detail-file-size"; size.textContent = formatFileSize(activeFile.file.size); metadata.append(name, size);
  const actions = document.createElement("div"); actions.className = "detail-file-actions";
  const view = document.createElement("button"); view.type = "button"; view.className = "detail-action"; view.innerHTML = `${icon("external-link", { size: 12, color: "currentColor" })}<span>Abrir</span>`; view.addEventListener("click", () => viewFile(activeFile.file));
  const download = document.createElement("button"); download.type = "button"; download.className = "detail-action"; download.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>Descargar</span>`; download.addEventListener("click", () => downloadFile(activeFile.file, activeFile.name));
  actions.append(view, download);
  if (state.selectedTab === "transcript") {
    const downloadTxt = document.createElement("button"); downloadTxt.type = "button"; downloadTxt.className = "detail-action"; downloadTxt.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>Descargar TXT</span>`;
    downloadTxt.addEventListener("click", () => downloadFile(new Blob([transcriptToTxt(activeFile.value)], { type: "text/plain" }), "transcripcion.txt"));
    const downloadMd = document.createElement("button"); downloadMd.type = "button"; downloadMd.className = "detail-action"; downloadMd.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>Descargar Markdown</span>`;
    downloadMd.addEventListener("click", () => downloadFile(new Blob([transcriptToMarkdown(activeFile.value, titleFor(meeting))], { type: "text/markdown" }), "transcripcion.md"));
    actions.append(downloadTxt, downloadMd);
  }
  const separator = document.createElement("span"); separator.className = "detail-footer-separator"; separator.setAttribute("aria-hidden", "true");
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-meeting-button"; remove.innerHTML = `${icon("trash-2", { size: 14, color: "currentColor" })}<span>Eliminar reunión</span>`; remove.addEventListener("click", () => showDeleteDialog(state.meetings.find((item) => meetingId(item) === state.selectedMeetingId), remove));
  fileRow.append(metadata, actions); footer.append(fileRow, separator, remove); return footer;
}
```

- [ ] **Step 6: Permitir que los botones de descarga hagan wrap en el panel angosto**

El footer del panel de detalle pasa de tener 2 a 4 botones de acción (Abrir, Descargar, Descargar TXT, Descargar Markdown) dentro de `.detail-file-actions`, que hoy tiene `flex: none` sin `flex-wrap` (hereda `nowrap`). En `src/history/history.html:41`, dentro del bloque de estilos del panel angosto:

```css
/* Antes: */
.detail-file-actions { flex: none; display: flex; align-items: center; gap: 8px; }

/* Después: */
.detail-file-actions { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: flex-end; }
```

- [ ] **Step 7: Actualizar el llamado a `createFileFooter` para pasar `meeting`, y verificar manualmente en el navegador**

```js
// Antes (dentro de renderDetail):
  try { const activeFile = await readActiveFile(meeting, state.selectedTab); if (`${state.selectedMeetingId}:${state.selectedTab}` !== renderKey) return; content.replaceChildren(); renderTabContent(content, activeFile); detail.appendChild(createFileFooter(activeFile)); } catch (error) { ... }

// Después:
  try { const activeFile = await readActiveFile(meeting, state.selectedTab); if (`${state.selectedMeetingId}:${state.selectedTab}` !== renderKey) return; content.replaceChildren(); renderTabContent(content, activeFile); detail.appendChild(createFileFooter(activeFile, meeting)); } catch (error) { ... }
```

Verificación manual (Codex debe reportar si pudo hacerla o no, dado que requiere una reunión real de Google Meet):
1. Correr `npm run build` y cargar la extensión sin empaquetar (`chrome://extensions` → modo desarrollador → "Cargar descomprimida" → seleccionar la raíz del repo, donde está `manifest.json`, no `src/`).
2. Grabar una reunión de Meet corta con captions activados, con al menos dos speakers distintos.
3. Detener la grabación, abrir el historial, entrar al detalle de esa reunión, pestaña "Transcripción".
4. Confirmar que la lista de intervenciones se ve igual que antes (hora, speaker en negrita, texto).
5. Abrir el manifest o inspeccionar OPFS (DevTools → Application → Storage) y confirmar que existe `transcripcion.json` (no `transcripcion.txt`) con el array de segmentos en camelCase.
6. Click en "Descargar TXT" y "Descargar Markdown": confirmar que se descargan `transcripcion.txt` y `transcripcion.md` con contenido legible y timestamps correctos.
7. Click en "Descargar" (el botón original): confirmar que descarga el `transcripcion.json` crudo.
8. Achicar la ventana del panel de historial y confirmar que los 4 botones del footer (Abrir, Descargar, Descargar TXT, Descargar Markdown) hacen wrap en vez de desbordar o solaparse.

- [ ] **Step 8: Commit**

```bash
git add src/history/history.js src/history/history.html
git commit -m "feat: render transcript JSON in history UI and add TXT/Markdown export"
```

---

## Self-Review

**Cobertura del alcance:**
- Formato JSON en camelCase con `index`, `startTime`, `endTime`, `text`, `speaker` (sin `speakerId`, sin `aiFilters`) → Task 2.
- Sin soporte para transcripciones viejas en `.txt`, sin migración → decisión ya tomada por el usuario, reflejada en el `Architecture` de este plan (no hay tarea de migración ni fallback de lectura).
- El JSON se parsea en el front para mostrar la transcripción → Task 3, Step 2 y 4.
- Opciones de descarga como TXT y Markdown → Task 1 (helpers puros) + Task 3, Step 5.

**Placeholders:** ninguno — todos los pasos tienen código completo, comandos exactos y snippets reales tomados del archivo actual.

**Consistencia de tipos/nombres:** `segment.speaker`/`segment.startTime`/`segment.endTime`/`segment.text`/`segment.index` se usan igual en `transcript-export.js`, `session-writer.js` y `history.js`. `transcriptToTxt`/`transcriptToMarkdown`/`formatSegmentTimestamp` se exportan con esos nombres exactos y se importan igual en `history.js` y en el test.

**Revisión de Codex incorporada:**
- Bug real corregido: `history.js` usaba `formatMediaTime` (da `"0:00"`) en vez de `formatSegmentTimestamp` (da `"00:00"`), lo que hubiera cambiado el formato visual de la transcripción respecto al que existía antes. Corregido en Task 3, Step 4.
- Bug real corregido: `transcriptToTxt` no normalizaba saltos de línea internos, lo que podía romper el formato "una línea por segmento". Corregido en Task 1, Step 3, con test agregado.
- Cobertura de test ampliada: se agregó un caso en Task 2 para snapshots consecutivos del mismo speaker (ya cubierto por la lógica de `CaptionParser`, pero no tenía test explícito a este nivel).
- Riesgo de layout corregido: se agregó Task 3, Step 6 para que los 4 botones del footer hagan `flex-wrap` en el panel angosto.
- Paso de verificación manual corregido: `npm run build` + cargar la raíz del repo (donde está `manifest.json`), no `src/`.

**Dejado fuera de este plan a propósito (señalado por Codex, no son regresiones de este cambio):**
- La precisión de `startedAt` como origen de los offsets relativos (`SessionWriter` lo fija en su propio constructor, no en el instante exacto en que arranca el grabador) es un comportamiento preexistente — el código viejo ya calculaba `segment.startMs - this.startedAt` de la misma forma para `transcripcion.txt`. Este plan no cambia esa semántica, solo el formato de salida.
- `hasCaption === true` con `finishedSegments` vacío no ocurre en el flujo normal actual (cada snapshot crea o actualiza `current`, y `finalizeCurrent()` siempre lo mueve a `finishedSegments`). Si ocurriera, este plan escribiría `[]` en `transcripcion.json`, que es equivalente en severidad al comportamiento viejo (escribía un string vacío en `transcripcion.txt`) — no es una regresión introducida por este cambio.
