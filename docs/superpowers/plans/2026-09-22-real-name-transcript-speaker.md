# Nombre real del usuario en la transcripción (reemplazo de "You") — Implementation Plan

> **Para quien ejecute este plan:** este proyecto NO usa `superpowers:subagent-driven-development` ni `superpowers:executing-plans` para la ejecución. Por las reglas del proyecto (`CLAUDE.md`), cada tarea de este plan se delega a Codex (agente `codex:codex-rescue`, `gpt-5.6-terra`, esfuerzo `medium` salvo que se indique otro), una por una, referenciando el archivo de este plan y el número exacto de tarea. Claude revisa lo que Codex devuelve antes de pasar a la siguiente tarea. Antes de ejecutar la Tarea 1, este plan completo debe pasar por una revisión de Codex (arquitectura, tareas, riesgos) — ya hubo una revisión de la arquitectura general antes de escribir este documento; falta la revisión del plan concreto tarea por tarea.

**Goal:** En la transcripción de una reunión, reemplazar el string "You" (que Google Meet le pone al propio usuario en el panel de subtítulos, sin importar el idioma real de esa persona) por su nombre real seguido de "(You)", ej. `"Ivan Gonzalez (You)"` — sin tocar cómo se resuelven los nombres de los demás participantes, que ya funcionan bien hoy.

**Architecture:** Se replica la técnica que usa el competidor Fireflies.ai (decompilada legítimamente desde su `.crx` público para esta investigación): en vez de confiar solo en el texto visible del panel de captions (`.NWpY1d`, que Meet localiza a "You" para el propio usuario), se lee la propiedad interna `element.__soy.data` que Meet adjunta a los "indicadores de hablante activo" (los círculos que se iluminan en la grilla de video cuando alguien habla) — ahí el nombre es siempre el real, para cualquier participante, incluido uno mismo. Esto corre en el content script MAIN world que ya existe (`src/webrtc-bootstrap/bootstrap.js`, el único con acceso a esa propiedad interna de la página). Los eventos de "cambio de hablante" (con timestamp) se mandan al mundo ISOLATED (`src/content/meet-detector.js`) y de ahí al offscreen document, donde se acumulan junto a los snapshots de captions ya existentes. Recién en `SessionWriter.finalize()`, un módulo puro nuevo (`src/lib/speaker-label-reconciler.js`) reconcilia ambos streams por timestamp (con los mismos umbrales de tolerancia que usa Fireflies: 100ms) antes de alimentar el `CaptionParser` existente, que no se modifica. Si la extracción de `__soy.data` falla en cualquier punto (Meet cambió su estructura interna, layout no soportado, etc.), cada caption cae automáticamente a su `speaker` original (el de `.NWpY1d` de siempre) — nunca se rompe lo que ya funciona.

**Tech Stack:** JavaScript vanilla (ES modules), Manifest V3 content scripts (MAIN + ISOLATED world), `MutationObserver`, Vitest + jsdom para tests.

**Contexto de la decisión (para quien lea esto sin haber estado en la conversación):** Se evaluaron tres alcances con el usuario: (1) pedir el nombre en la configuración de la extensión, (2) leerlo una sola vez del DOM (ej. panel de Participantes de Meet, que ya muestra "Nombre (You)" nativamente) y aplicarlo como parche puntual sobre "You", (3) replicar el sistema completo de Fireflies, reasignando el hablante real de cada intervención transcripta vía los indicadores de hablante activo. El usuario eligió explícitamente la opción (3) después de ver el análisis de la extensión de Fireflies decompilada, aun sabiendo que es más compleja y depende de una API interna no documentada de Meet (`__soy`) que puede cambiar sin aviso. La arquitectura de este plan fue revisada por Codex antes de escribirse (ver resumen de su revisión en el historial de esta sesión); sus recomendaciones —módulo de reconciliación separado de `CaptionParser`, fallback automático, encapsular todo acceso a `__soy` en una sola función, timestamps generados en el observer de origen— están incorporadas abajo.

**Riesgos conocidos, no resueltos por este plan (documentar en `asterion-alcance.md` al terminar):**
- `__soy.data` y el índice posicional `space[28]` son internals no documentados de Meet — pueden romperse con cualquier actualización, sin aviso. La mitigación es el fallback automático a `.NWpY1d`, no una garantía de que el nombre real siempre se resuelva.
- Los primeros segundos de una reunión pueden mostrar "You" en vez del nombre real hasta que el indicador de hablante activo se detecte por primera vez (nadie habló todavía, o el layout de video no expuso el indicador aún).
- Layouts de Meet no probados (pantalla compartida, spotlight con un solo participante grande, más de ~10 participantes en mosaico paginado) pueden no exponer el indicador de la misma forma — no se investiga cada variante en este plan, solo se deja el fallback como red de seguridad.
- Los mensajes `window.postMessage` entre MAIN e ISOLATED no validan hoy un `sessionId` estricto contra la sesión activa (limitación preexistente en `bootstrap.js`/`meet-detector.js`, no introducida por este plan) — no se endurece acá para no mezclar alcance; si se quiere abordar, es un plan aparte.

---

### Task 1: `speaker-label-reconciler.js` — reconciliación pura de dos streams por timestamp

**Files:**
- Create: `src/lib/speaker-label-reconciler.js`
- Test: `src/lib/speaker-label-reconciler.test.js`

Este módulo no toca el DOM ni conoce Meet — recibe dos arrays ya armados (`captions` y `speakerLabels`, ambos con `timestampMs` en la misma base de tiempo, `Date.now()`) y devuelve un array de snapshots `{speaker, text, timestampMs}` listo para pasarle a `CaptionParser` tal cual se le pasa hoy.

Contrato:
- `captions`: array de `{ speaker, text, timestampMs }` (el mismo shape que ya produce `meet-caption-observer.js`).
- `speakerLabels`: array de `{ speakerName: string | null, timestampMs }`. `speakerName: null` es un marcador de "silencio" (nadie hablando) — cierra la ventana del hablante anterior sin abrir una nueva.
- Si `speakerLabels` está vacío, el resultado es exactamente `captions` mapeado a `{speaker, text, timestampMs}` (passthrough, sin ningún cambio) — esto es lo que hoy ya cubren los tests existentes de `session-writer.test.js` que llaman `onCaptionSnapshot` sin ningún label, y no deben dejar de pasar.
- Cada label abre una "ventana" de tiempo que dura hasta el siguiente label (o hasta el final, si es el último). Ventanas consecutivas del mismo `speakerName` con un gap `<= maxLabelDistanceMs` se colapsan en una sola. Ventanas cuya duración final sea `<= minLabelDurationMs` se descartan (ruido). Solo las ventanas con `speakerName` no nulo y no descartadas participan en el matching.
- Cada caption busca la ventana elegible que la contiene (con un margen de tolerancia de `maxLabelDistanceMs` en los bordes); si encuentra una, usa `speakerName` de esa ventana; si no, conserva su `speaker` original.
- Caso especial (el motivo de todo este plan): si el `speaker` **original** de la caption era exactamente `"You"` (el marcador que Meet le pone al propio usuario) y se encontró una ventana que la cubre, el resultado no es el nombre real "pelado" sino `` `${speakerName} (You)` `` — así se preserva la señal de "esto lo dijiste vos" además de mostrar el nombre real. Para cualquier otro `speaker` original (ya sea un nombre real de otro participante, o `"You"` sin ninguna ventana que la cubra) no se agrega ningún sufijo.

- [ ] **Step 1: Escribir los tests (deben fallar — el archivo todavía no existe)**

```js
// src/lib/speaker-label-reconciler.test.js
import { describe, expect, it } from "vitest";
import { reconcileCaptionSnapshots } from "./speaker-label-reconciler.js";

describe("reconcileCaptionSnapshots", () => {
  it("returns captions unchanged when there are no speaker labels", () => {
    const captions = [
      { speaker: "You", text: "Hola", timestampMs: 1000 },
      { speaker: "Ana", text: "Hola de vuelta", timestampMs: 2000 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels: [] })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 1000 },
      { speaker: "Ana", text: "Hola de vuelta", timestampMs: 2000 },
    ]);
  });

  it("replaces 'You' with the real name plus a (You) suffix when a label covers it", () => {
    const captions = [{ speaker: "You", text: "Hola a todos", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ivan Gonzalez", timestampMs: 950 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ivan Gonzalez (You)", text: "Hola a todos", timestampMs: 1000 },
    ]);
  });

  it("replaces a non-'You' speaker with the plain real name, no (You) suffix", () => {
    const captions = [{ speaker: "Beto", text: "Hola", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ana", timestampMs: 950 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ana", text: "Hola", timestampMs: 1000 },
    ]);
  });

  it("falls back to the original speaker when no label window covers the caption", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ivan Gonzalez", timestampMs: 5000 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 1000 },
    ]);
  });

  it("collapses consecutive same-speaker labels within maxLabelDistanceMs", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 1080 }];
    const speakerLabels = [
      { speakerName: "Ivan Gonzalez", timestampMs: 900 },
      { speakerName: "Ivan Gonzalez", timestampMs: 990 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ivan Gonzalez (You)", text: "Hola", timestampMs: 1080 },
    ]);
  });

  it("discards a label window shorter than minLabelDurationMs as noise", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 1005 }];
    const speakerLabels = [
      { speakerName: "Ivan Gonzalez", timestampMs: 1000 },
      { speakerName: null, timestampMs: 1010 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 1005 },
    ]);
  });

  it("does not let two adjacent speakers' tolerance windows steal a caption that falls inside the newer one", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 2050 }];
    const speakerLabels = [
      { speakerName: "Ana", timestampMs: 1000 },
      { speakerName: "Beto", timestampMs: 2000 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Beto (You)", text: "Hola", timestampMs: 2050 },
    ]);
  });

  it("a null speakerName label closes the previous window (silence) without starting a new one", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 3000 }];
    const speakerLabels = [
      { speakerName: "Ivan Gonzalez", timestampMs: 1000 },
      { speakerName: null, timestampMs: 2000 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 3000 },
    ]);
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run src/lib/speaker-label-reconciler.test.js`
Expected: FAIL con "Failed to resolve import" o "no existe el módulo" (el archivo de implementación no existe todavía).

- [ ] **Step 3: Implementar `speaker-label-reconciler.js`**

```js
// src/lib/speaker-label-reconciler.js

function buildWindows(sortedLabels, maxLabelDistanceMs) {
  const raw = sortedLabels.map((label, index) => {
    const next = sortedLabels[index + 1];
    return {
      speakerName: label.speakerName,
      startMs: label.timestampMs,
      endMs: next ? next.timestampMs : Infinity,
    };
  });

  const collapsed = [];
  for (const window of raw) {
    const prev = collapsed[collapsed.length - 1];
    // Ojo: no comparar contra prev.endMs — en las ventanas crudas (antes de
    // colapsar) prev.endMs siempre coincide exactamente con window.startMs (una
    // termina donde arranca la siguiente), así que esa resta siempre daría 0 y
    // colapsaría cualquier par del mismo hablante sin importar cuánto tiempo
    // pasó entre medio. Hay que comparar contra dónde arrancó la ventana
    // anterior (el timestamp del label que la originó).
    if (prev && prev.speakerName === window.speakerName && window.startMs - prev.startMs <= maxLabelDistanceMs) {
      prev.endMs = window.endMs;
    } else {
      collapsed.push({ ...window });
    }
  }
  return collapsed;
}

export function reconcileCaptionSnapshots({ captions, speakerLabels, maxLabelDistanceMs = 100, minLabelDurationMs = 100 }) {
  if (!speakerLabels || speakerLabels.length === 0) {
    return captions.map(({ speaker, text, timestampMs }) => ({ speaker, text, timestampMs }));
  }

  const sortedLabels = [...speakerLabels].sort((a, b) => a.timestampMs - b.timestampMs);
  const eligibleWindows = buildWindows(sortedLabels, maxLabelDistanceMs).filter(
    (window) => window.speakerName !== null && window.endMs - window.startMs > minLabelDurationMs
  );

  return captions.map(({ speaker, text, timestampMs }) => {
    // Dos ventanas de hablantes adyacentes, cada una con su margen de tolerancia,
    // se solapan cerca de la transición. Hay que preferir siempre la ventana que
    // contiene el timestamp de forma exacta (sin tolerancia) antes de caer al
    // matching tolerante — si no, .find() puede devolver la ventana anterior
    // (la primera en el array) para un caption que en realidad cae dentro de la
    // ventana siguiente.
    const exactMatch = eligibleWindows.find((window) => timestampMs >= window.startMs && timestampMs < window.endMs);
    const match =
      exactMatch ??
      eligibleWindows.find(
        (window) => timestampMs >= window.startMs - maxLabelDistanceMs && timestampMs < window.endMs + maxLabelDistanceMs
      );
    if (!match) return { speaker, text, timestampMs };
    const resolvedSpeaker = speaker === "You" ? `${match.speakerName} (You)` : match.speakerName;
    return { speaker: resolvedSpeaker, text, timestampMs };
  });
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/lib/speaker-label-reconciler.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/speaker-label-reconciler.js src/lib/speaker-label-reconciler.test.js
git commit -m "feat: add pure reconciler for speaker-label and caption streams"
```

---

### Task 2: `speaker-dom.js` — extracción defensiva del nombre real desde `__soy.data`

**Files:**
- Create: `src/webrtc-bootstrap/speaker-dom.js`
- Test: `src/webrtc-bootstrap/speaker-dom.test.js`

Aísla todo el acceso a la API interna no documentada de Meet en dos funciones puras, testeables con jsdom construyendo el DOM y las propiedades `__soy` a mano (jsdom permite asignar propiedades arbitrarias a los elementos, igual que hace Meet en el navegador real).

- [ ] **Step 1: Escribir los tests**

```js
// src/webrtc-bootstrap/speaker-dom.test.js
import { describe, expect, it } from "vitest";
import { findSpeakerAwareIndicators, extractSpeakerNameFromIndicator } from "./speaker-dom.js";

function makeIndicator({ soyKey = "someprefix_speakerAware_suffix", childCount = 3, firstHasChildren = false, lastHasChildren = false } = {}) {
  const el = document.createElement("div");
  el.setAttribute("jscontroller", "abc123");
  el.__soy = { key: soyKey };
  for (let i = 0; i < childCount; i++) {
    const child = document.createElement("span");
    if (i === 0 && firstHasChildren) child.appendChild(document.createElement("i"));
    if (i === childCount - 1 && lastHasChildren) child.appendChild(document.createElement("i"));
    el.appendChild(child);
  }
  return el;
}

describe("findSpeakerAwareIndicators", () => {
  it("finds a div with jscontroller and __soy.key including speakerAware, 3 childless-edge children", () => {
    document.body.innerHTML = "";
    const indicator = makeIndicator();
    document.body.appendChild(indicator);
    expect(findSpeakerAwareIndicators()).toEqual([indicator]);
  });

  it("ignores divs without __soy", () => {
    document.body.innerHTML = "";
    const el = document.createElement("div");
    el.setAttribute("jscontroller", "abc123");
    document.body.appendChild(el);
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });

  it("ignores divs whose __soy.key does not include speakerAware", () => {
    document.body.innerHTML = "";
    document.body.appendChild(makeIndicator({ soyKey: "somethingElse" }));
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });

  it("ignores divs without exactly 3 children", () => {
    document.body.innerHTML = "";
    document.body.appendChild(makeIndicator({ childCount: 2 }));
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });

  it("ignores divs whose first or last child already has child nodes", () => {
    document.body.innerHTML = "";
    document.body.appendChild(makeIndicator({ firstHasChildren: true }));
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });
});

describe("extractSpeakerNameFromIndicator", () => {
  it("reads the name from the nearest ancestor's __soy.data at position 28", () => {
    const indicator = makeIndicator();
    const parent = document.createElement("div");
    const space = new Array(29).fill(null);
    space[28] = "Ivan Gonzalez";
    parent.__soy = { data: { someKey: { innerKey: space } } };
    parent.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBe("Ivan Gonzalez");
  });

  it("climbs multiple levels until it finds an ancestor with __soy.data", () => {
    const indicator = makeIndicator();
    const grandparent = document.createElement("div");
    const parent = document.createElement("div");
    const space = new Array(29).fill(null);
    space[28] = "Ana";
    grandparent.__soy = { data: { k: { j: space } } };
    parent.appendChild(indicator);
    grandparent.appendChild(parent);
    expect(extractSpeakerNameFromIndicator(indicator)).toBe("Ana");
  });

  it("returns null when no ancestor has __soy.data", () => {
    const indicator = makeIndicator();
    document.body.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBeNull();
  });

  it("returns null when position 28 is not a non-empty string", () => {
    const indicator = makeIndicator();
    const parent = document.createElement("div");
    parent.__soy = { data: { k: { j: new Array(29).fill(null) } } };
    parent.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBeNull();
  });

  it("returns null and does not throw when position 28 is a suspiciously long string", () => {
    const indicator = makeIndicator();
    const parent = document.createElement("div");
    const space = new Array(29).fill(null);
    space[28] = "x".repeat(500);
    parent.__soy = { data: { k: { j: space } } };
    parent.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run src/webrtc-bootstrap/speaker-dom.test.js`
Expected: FAIL (el módulo no existe todavía).

- [ ] **Step 3: Implementar `speaker-dom.js`**

```js
// src/webrtc-bootstrap/speaker-dom.js
// Lee una propiedad interna no documentada de Meet (`__soy`, del framework Closure/
// Soy de Google) que no está pensada como API pública y puede cambiar sin aviso
// entre versiones de Meet. Toda esta fragilidad queda encapsulada acá — si algo
// no calza con lo esperado, se devuelve null y quien llama cae al nombre que ya
// muestra el panel de captions (".NWpY1d", "You" incluido).

const MAX_SPEAKER_NAME_LENGTH = 200;

export function findSpeakerAwareIndicators() {
  const candidates = document.querySelectorAll("div[jscontroller]");
  const indicators = [];
  for (const el of candidates) {
    const soyKey = el.__soy?.key;
    if (typeof soyKey !== "string" || !soyKey.includes("speakerAware")) continue;
    if (el.children.length !== 3) continue;
    const first = el.firstElementChild;
    const last = el.lastElementChild;
    if (first?.hasChildNodes() || last?.hasChildNodes()) continue;
    indicators.push(el);
  }
  return indicators;
}

export function extractSpeakerNameFromIndicator(indicatorEl) {
  let node = indicatorEl.parentNode;
  while (node) {
    const soyData = node.__soy?.data;
    if (soyData && typeof soyData === "object") {
      const dataKey = Object.keys(soyData).find((key) => typeof soyData[key] === "object" && soyData[key] !== null);
      if (!dataKey) return null;
      const spaceObj = soyData[dataKey];
      const spaceKey = Object.keys(spaceObj)[0];
      const space = spaceKey !== undefined ? spaceObj[spaceKey] : null;
      const candidate = Array.isArray(space) ? space[28] : undefined;
      if (typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= MAX_SPEAKER_NAME_LENGTH) {
        return candidate.trim();
      }
      return null;
    }
    node = node.parentNode;
  }
  return null;
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/webrtc-bootstrap/speaker-dom.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/speaker-dom.js src/webrtc-bootstrap/speaker-dom.test.js
git commit -m "feat: extract real speaker name from Meet's internal __soy data"
```

---

### Task 3: `speaker-observer.js` — orquestación en MAIN world (MutationObservers, silencio sintético, cleanup)

**Files:**
- Create: `src/webrtc-bootstrap/speaker-observer.js`
- Test: `src/webrtc-bootstrap/speaker-observer.test.js`
- Depends on: `src/webrtc-bootstrap/speaker-dom.js` (Tarea 2), `src/content/meet-selectors.js` (ya existe, se reusa `findByIconText`)

- [ ] **Step 1: Escribir los tests**

```js
// src/webrtc-bootstrap/speaker-observer.test.js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpeakerObserver } from "./speaker-observer.js";

function appendIndicatorWithName(name) {
  const parent = document.createElement("div");
  const space = new Array(29).fill(null);
  space[28] = name;
  parent.__soy = { data: { k: { j: space } } };

  const indicator = document.createElement("div");
  indicator.setAttribute("jscontroller", "abc");
  indicator.__soy = { key: "x_speakerAware_y" };
  for (let i = 0; i < 3; i++) indicator.appendChild(document.createElement("span"));

  parent.appendChild(indicator);
  document.body.appendChild(parent);
  return indicator;
}

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

describe("startSpeakerObserver", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a label when a speaker-aware indicator's attributes change", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();

    expect(onSpeakerLabel).toHaveBeenCalledWith({ speakerName: "Ivan Gonzalez", timestampMs: expect.any(Number) });
    stop();
  });

  it("does not emit twice in a row for the same speaker", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();
    indicator.setAttribute("class", "is-speaking-still");
    await flush();

    expect(onSpeakerLabel).toHaveBeenCalledTimes(1);
    stop();
  });

  it("emits a silence label (speakerName: null) after MAX_SILENCE_DURATION_MS of no change", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();
    vi.advanceTimersByTime(2000);
    await flush();

    expect(onSpeakerLabel).toHaveBeenLastCalledWith({ speakerName: null, timestampMs: expect.any(Number) });
    stop();
  });

  it("renews the silence timer on repeated activity from the same speaker instead of timing out", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();
    vi.advanceTimersByTime(1500);
    indicator.setAttribute("class", "is-speaking-again");
    await flush();
    vi.advanceTimersByTime(1500);
    await flush();

    // Pasaron 3000ms en total, pero la actividad a los 1500ms debió reiniciar
    // el timer de silencio — todavía no deberían pasar 2000ms sin actividad.
    expect(onSpeakerLabel).not.toHaveBeenCalledWith({ speakerName: null, timestampMs: expect.any(Number) });
    stop();
  });

  it("stop() disconnects observers so no further labels are emitted", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });
    stop();

    indicator.setAttribute("class", "is-speaking");
    await flush();

    expect(onSpeakerLabel).not.toHaveBeenCalled();
  });

  it("does not throw and does not emit when there are no indicators in the DOM", () => {
    const onSpeakerLabel = vi.fn();
    expect(() => startSpeakerObserver({ onSpeakerLabel })).not.toThrow();
    expect(onSpeakerLabel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run src/webrtc-bootstrap/speaker-observer.test.js`
Expected: FAIL (el módulo no existe todavía).

- [ ] **Step 3: Implementar `speaker-observer.js`**

```js
// src/webrtc-bootstrap/speaker-observer.js
import { findSpeakerAwareIndicators, extractSpeakerNameFromIndicator } from "./speaker-dom.js";
import { findByIconText } from "../content/meet-selectors.js";

const MAX_SILENCE_DURATION_MS = 2000;
const RESCAN_DEBOUNCE_MS = 200;

export function startSpeakerObserver({ onSpeakerLabel, log = () => {} }) {
  const observedIndicators = new WeakSet();
  const indicatorObservers = [];
  let silenceTimer = null;
  let lastSpeakerName = null;
  let rescanTimer = null;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => emit(null), MAX_SILENCE_DURATION_MS);
  }

  function emit(speakerName) {
    lastSpeakerName = speakerName;
    onSpeakerLabel({ speakerName, timestampMs: Date.now() });
    if (speakerName !== null) resetSilenceTimer();
  }

  function handleIndicatorChange(indicatorEl) {
    const speakerName = extractSpeakerNameFromIndicator(indicatorEl);
    if (speakerName === null) return;
    if (speakerName === lastSpeakerName) {
      // Sigue siendo el mismo hablante activo — no es un cambio para emitir,
      // pero sí es actividad real: sin este reset, alguien que habla de forma
      // continua por más de MAX_SILENCE_DURATION_MS dispararía igual el
      // marcador sintético de "silencio" a mitad de su propia intervención.
      resetSilenceTimer();
      return;
    }
    emit(speakerName);
  }

  function observeIndicator(indicatorEl) {
    if (observedIndicators.has(indicatorEl)) return;
    observedIndicators.add(indicatorEl);
    const observer = new MutationObserver(() => handleIndicatorChange(indicatorEl));
    observer.observe(indicatorEl, { attributes: true, subtree: false, childList: false });
    indicatorObservers.push(observer);
  }

  function scanForIndicators() {
    const indicators = findSpeakerAwareIndicators();
    log("speaker-observer-scan", { found: indicators.length });
    for (const indicatorEl of indicators) observeIndicator(indicatorEl);
  }

  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scanForIndicators();
    }, RESCAN_DEBOUNCE_MS);
  }

  scanForIndicators();

  let layoutObserver = null;
  if (findByIconText("more_vert")) {
    layoutObserver = new MutationObserver(scheduleRescan);
    layoutObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    log("speaker-observer-no-layout-anchor", {});
  }

  return function stopSpeakerObserver() {
    for (const observer of indicatorObservers) observer.disconnect();
    indicatorObservers.length = 0;
    layoutObserver?.disconnect();
    if (silenceTimer) clearTimeout(silenceTimer);
    if (rescanTimer) clearTimeout(rescanTimer);
  };
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/webrtc-bootstrap/speaker-observer.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/speaker-observer.js src/webrtc-bootstrap/speaker-observer.test.js
git commit -m "feat: observe Meet's active-speaker indicators and emit timestamped labels"
```

---

### Task 4: Wirear `speaker-observer.js` al ciclo de vida de la sesión en `bootstrap.js`

**Files:**
- Modify: `src/webrtc-bootstrap/bootstrap.js`

No lleva test nuevo — `bootstrap.js` es código de wiring sin tests unitarios hoy (igual que el resto de sus responsabilidades de orquestación), y su comportamiento se valida en la Tarea 8 (verificación manual en una reunión real).

- [ ] **Step 1: Importar `startSpeakerObserver` y declarar el stop-handle**

En `src/webrtc-bootstrap/bootstrap.js:1-21`, agregar el import y la variable de estado junto a las que ya existen:

```js
import {
  installRtcPatch,
  installGetUserMediaPatch,
  installReplaceTrackPatch,
  getCurrentLocalAudioTrack,
  diagnostics,
} from "./rtc-patch.js";
import { MeetingAudioMixer } from "./audio-mixer.js";
import { MainWorldSession } from "./session.js";
import { startSpeakerObserver } from "./speaker-observer.js";
```

Y junto a `let micTrack = null; let session = null; let currentlyMuted = false;` (línea 20-22):

```js
let stopSpeakerObserver = () => {};
```

- [ ] **Step 2: Arrancar el observer al iniciar sesión**

En el handler de `"asterion:start-session"` (`bootstrap.js:80-115`), justo después de `postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });`, agregar:

```js
stopSpeakerObserver = startSpeakerObserver({
  onSpeakerLabel: (label) => postToIsolated({ type: "asterion:speaker-label", sessionId: message.sessionId, label }),
  log: rtcPatchLog,
});
```

- [ ] **Step 3: Detener el observer al finalizar sesión**

En el handler de `"asterion:stop-session"` (`bootstrap.js:122-126`), agregar la llamada de limpieza:

```js
} else if (message.type === "asterion:stop-session") {
  session?.stop();
  session = null;
  mixer.stopReconciliation();
  stopSpeakerObserver();
  stopSpeakerObserver = () => {};
}
```

- [ ] **Step 4: Verificar que el build sigue funcionando**

Run: `npm run build:webrtc`
Expected: termina sin errores y regenera `dist/webrtc-bootstrap.bundle.js`.

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/bootstrap.js
git commit -m "feat: start/stop the speaker observer with the recording session"
```

---

### Task 5: Reenviar los speaker labels desde el mundo ISOLATED (`meet-detector.js`)

**Files:**
- Modify: `src/content/meet-detector.js`

- [ ] **Step 1: Agregar el caso al listener de mensajes del MAIN world**

En `src/content/meet-detector.js`, dentro de `window.addEventListener("message", (event) => { ... })` (línea 99-141), agregar un nuevo `else if` junto a los existentes (por ejemplo después del bloque de `"asterion:chunk"`, línea 113-120):

```js
} else if (message.type === "asterion:speaker-label") {
  chrome.runtime.sendMessage({
    type: "asterion:speaker-label",
    sessionId: message.sessionId,
    label: message.label,
  });
}
```

- [ ] **Step 2: Verificar que el build sigue funcionando**

Run: `npm run build:content`
Expected: termina sin errores y regenera `dist/content.bundle.js`.

- [ ] **Step 3: Commit**

```bash
git add src/content/meet-detector.js
git commit -m "feat: forward speaker-label events from MAIN world to the extension messaging"
```

---

### Task 6: Recibir los speaker labels en el offscreen document

**Files:**
- Modify: `src/offscreen/offscreen.js`

- [ ] **Step 1: Agregar el caso al listener de `chrome.runtime.onMessage`**

En `src/offscreen/offscreen.js`, junto al bloque de `"asterion:caption-snapshot"` (línea 20-21), agregar:

```js
} else if (message.type === "asterion:speaker-label") {
  sessions.get(message.sessionId)?.onSpeakerLabel(message.label);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/offscreen/offscreen.js
git commit -m "feat: route speaker-label messages to the active session's writer"
```

(No hay test unitario para `offscreen.js` hoy — es un router de mensajes sin tests existentes, igual que el resto de sus casos.)

---

### Task 7: `SessionWriter` — acumular ambos streams y reconciliar en `finalize()`

**Files:**
- Modify: `src/storage/session-writer.js`
- Modify: `src/storage/session-writer.test.js`

- [ ] **Step 1: Escribir el test que prueba la reconciliación end-to-end (debe fallar)**

Agregar al final de `describe("SessionWriter conversion flow", ...)` en `src/storage/session-writer.test.js`, después del test `"does not write any transcript file when there were no captions"` (línea 210-219):

```js
it("uses the reconciled speaker label instead of the raw caption speaker when one is available", async () => {
  ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
  const writer = await createWriter({ audio: true, video: false });
  const finished = finishConversions(writer);

  writer.onSpeakerLabel({ speakerName: "Ivan Gonzalez", timestampMs: writer.startedAt + 900 });
  writer.onCaptionSnapshot({ speaker: "You", text: "Hola a todos", timestampMs: writer.startedAt + 1000 });

  const endedAt = writer.startedAt + 3000;
  await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
  await finished;

  const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
  const segments = JSON.parse(new TextDecoder().decode(bytes));

  // endTime es 3000 (no 1000): al haber un solo snapshot, el segmento queda
  // "abierto" hasta que finalizeCurrent(endedAt) lo cierra al final de la
  // sesión — mismo comportamiento que CaptionParser ya tiene hoy para el
  // último segmento de cualquier transcripción (ver el test existente
  // "writes transcripcion.json..." más arriba en este archivo, donde el
  // segmento de Luis también termina en endedAt y no en su propio timestamp).
  expect(segments).toEqual([
    { index: 0, startTime: 1000, endTime: 3000, text: "Hola a todos", speaker: "Ivan Gonzalez (You)" },
  ]);
});

it("keeps the original caption speaker when no speaker label was ever received", async () => {
  ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
  const writer = await createWriter({ audio: true, video: false });
  const finished = finishConversions(writer);

  writer.onCaptionSnapshot({ speaker: "You", text: "Hola", timestampMs: writer.startedAt + 1000 });

  const endedAt = writer.startedAt + 2000;
  await writer.finalize({ muteManifest: { intervals: [] }, endedAt });
  await finished;

  const bytes = writer.meetingHandle.files.get("transcripcion.json").bytes;
  const segments = JSON.parse(new TextDecoder().decode(bytes));

  expect(segments).toEqual([{ index: 0, startTime: 1000, endTime: 2000, text: "Hola", speaker: "You" }]);
});
```

- [ ] **Step 2: Correr los tests y verificar que el primero falla**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: el test `"uses the reconciled speaker label..."` FALLA (`writer.onSpeakerLabel is not a function`); el resto sigue pasando.

- [ ] **Step 3: Implementar los cambios en `SessionWriter`**

En `src/storage/session-writer.js`, agregar el import (línea 1-3):

```js
import { CaptionParser } from "../lib/caption-parser.js";
import { reconcileCaptionSnapshots } from "../lib/speaker-label-reconciler.js";
import { runFfmpegJob } from "../offscreen/ffmpeg-client.js";
```

En el constructor (línea 27-39), agregar los dos buffers junto a `this.captionParser`:

```js
this.captionParser = new CaptionParser();
this.captionSnapshots = [];
this.speakerLabels = [];
this.hasCaption = false;
```

Reemplazar `onCaptionSnapshot` (línea 74-77) para que solo acumule, y agregar `onSpeakerLabel`:

```js
onCaptionSnapshot(snapshot) {
  this.hasCaption = true;
  this.captionSnapshots.push(snapshot);
}

onSpeakerLabel(label) {
  this.speakerLabels.push(label);
}
```

En `finalize()` (línea 79-133), quitar la línea `this.captionParser.finalizeCurrent(this.endedAt);` que hoy está justo después de `await this.ready;` (línea 85) — se mueve más abajo. El bloque `if (this.hasCaption) { ... }` (línea 93-108) queda así:

```js
if (this.hasCaption) {
  const reconciled = reconcileCaptionSnapshots({
    captions: this.captionSnapshots,
    speakerLabels: this.speakerLabels,
  });
  for (const snapshot of reconciled) {
    this.captionParser.onSnapshot(snapshot);
  }
  this.captionParser.finalizeCurrent(this.endedAt);

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

El resto de `finalize()` (a partir de `this.hasVideo = ...`) no cambia.

- [ ] **Step 4: Correr los tests y verificar que todos pasan**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: PASS (todos, incluidos los dos nuevos).

- [ ] **Step 5: Correr toda la suite para descartar regresiones**

Run: `npx vitest run`
Expected: PASS en todos los archivos de test del proyecto.

- [ ] **Step 6: Commit**

```bash
git add src/storage/session-writer.js src/storage/session-writer.test.js
git commit -m "feat: reconcile speaker labels with captions before writing the transcript"
```

---

### Task 8: Verificación manual en una reunión real de Google Meet

**Files:** ninguno (solo verificación, sin cambios de código).

Esto no se puede automatizar ni verificar sin una reunión real — quien ejecute esta tarea debe reportar explícitamente qué pudo confirmar y qué no.

- [ ] **Step 1: Grabar una reunión real de Meet con al menos dos participantes (uno de ellos el usuario) y hablar unos minutos, incluyendo tramos de silencio y de superposición (dos hablando a la vez)**

- [ ] **Step 2: Abrir `transcripcion.json` de esa sesión y confirmar:**
  - Las intervenciones del usuario dicen su nombre real seguido de `" (You)"` — no `"You"` a secas (esto lo resuelve `speaker-label-reconciler.js`, Tarea 1: cuando la caption original decía `"You"` y hay una ventana de hablante que la cubre, el resultado es `` `${nombreReal} (You)` ``, no el nombre pelado).
  - Las intervenciones de los demás participantes siguen mostrando sus nombres reales, sin cambios de comportamiento respecto a antes de este plan.
  - No hay intervenciones perdidas ni mezcladas de forma obviamente incorrecta (ej. una frase larga partida a la mitad entre dos hablantes distintos sin que nadie haya hablado en el medio).
- [ ] **Step 3: Revisar la consola de la pestaña de Meet durante la grabación** (los `console.debug` de `rtcPatchLog`, prefijo `[Ariadne:rtc-patch] speaker-observer-*`) y confirmar que no hay errores no controlados ni un volumen sospechoso de indicadores encontrados (por ejemplo, cientos, lo que indicaría que el selector está matcheando de más).
- [ ] **Step 4: Probar al menos un layout distinto al de mosaico por defecto** (ej. activar "Vista de mosaico" vs. "Vista automática", o compartir pantalla) y anotar si el nombre real se sigue resolviendo o si cae al fallback ("You"/nombre real de siempre vía `.NWpY1d`) en ese caso — es un resultado válido y esperado que a veces caiga al fallback, lo que no es válido es que la grabación se rompa o quede sin transcripción.
- [ ] **Step 5: Reportar explícitamente** (a quien pidió esta tarea) qué se verificó con éxito, qué cayó al fallback y en qué circunstancia, y qué quedó sin probar por falta de tiempo o de un escenario disponible (ej. no se pudo probar con 10+ participantes).

---

## Nota de auto-revisión (cobertura del alcance)

Este plan pasó por dos rondas de revisión de Codex antes de ejecutarse: una sobre la arquitectura general (antes de escribirlo) y otra sobre el documento final tarea por tarea, que encontró y corrigió varios bugs reales en el algoritmo de `speaker-label-reconciler.js` (el colapso de ventanas comparaba mal los timestamps, el matching por tolerancia podía robarle un caption a la ventana equivocada cerca de una transición de hablante), en el manejo del timer de silencio de `speaker-observer.js` (no se renovaba con actividad continua del mismo hablante), y en los valores esperados de `endTime` de los tests nuevos de `SessionWriter` (Tarea 7). Todo eso ya está corregido en el contenido de las tareas de abajo — no quedan pendientes de esa revisión.

### Corrección post-verificación manual (Tarea 8, 2026-09-23)

Las Tareas 1-7 se implementaron, revisaron y commitearon tal como describe este plan (commits `3cf81ad`, `a1db6f3`, `f280110`, `ec216bc`, `9fd95f9`, `4f01285`, `7f2f5c5`). Al hacer la Tarea 8 (verificación manual en una reunión real), la transcripción siguió mostrando `"speaker": "You"` sin ningún nombre real — el pipeline de mensajería funcionaba (confirmado por los logs `[Ariadne:rtc-patch] speaker-observer-scan`), pero `speaker-observer-scan` reportaba `{found: 0}` durante toda la sesión: nunca encontró ni un solo indicador.

Diagnóstico hecho en vivo contra el DOM real de Meet (scripts corridos en la consola de la pestaña, no en la de la extensión) reveló dos bugs reales en `speaker-dom.js` (Tarea 2), ambos heredados de una versión distinta/más vieja del bundle decompilado de Fireflies que no coincide con el Meet actual:

1. **`findSpeakerAwareIndicators` exigía una forma incorrecta.** Se asumía "exactamente 3 hijos, con los extremos sin hijos propios" — el indicador real es un único `<div jscontroller>` con **un solo hijo**. El substring `"speakerAware"` sí era correcto (el `__soy.key` real es `"iEqC6d27:speakerAwareVolumeIndicator"`), pero el chequeo de estructura descartaba el único candidato real. Corregido: se sacaron los chequeos de cantidad de hijos y se afinó el substring a `"speakerAwareVolumeIndicator"` (más específico que el genérico `"speakerAware"`, que también matchea `"speakerBorder"` sin ser lo que buscamos).

2. **`extractSpeakerNameFromIndicator` se rendía en el primer ancestro con `__soy.data`, aunque ese `data` no tuviera un nombre usable.** En una reunión real, el indicador está envuelto en varios niveles intermedios que sí tienen `__soy.data` (ej. solo con clases CSS y una función de render, sin nombre) antes de llegar —recién 3 niveles más arriba— al ancestro con el nombre real en `data.uc.zn[28]`. La función original devolvía `null` en el primer wrapper vacío y nunca llegaba al correcto. Corregido: ahora sigue subiendo mientras el candidato en el índice `28` no sea una string válida, hasta un máximo de `MAX_ANCESTOR_CLIMB = 20` niveles.

El índice posicional `28` (heredado de Fireflies) se confirmó **correcto** contra un dato real: `data.uc.zn[28] === "Iván González"` (nombre completo real del usuario), con `zn[37] === "Iván"` (solo el nombre) y `zn[76] === "ivan gonzalez"` (versión normalizada en minúsculas) como vecinos — así que si en el futuro hace falta un formato distinto (solo nombre, sin apellido), esos otros índices son candidatos a probar, aunque tampoco están documentados por Google y podrían no ser estables.

Cambios aplicados en el commit `b735d2f` (`src/webrtc-bootstrap/speaker-dom.js`, `speaker-dom.test.js`, `speaker-observer.test.js`) — no se tocó `speaker-label-reconciler.js`, `speaker-observer.js` (la orquestación en sí), ni el wiring de `bootstrap.js`/`meet-detector.js`/`offscreen.js`/`session-writer.js`, porque el problema estaba enteramente contenido en cómo se localizaba y leía el DOM, no en cómo se procesaban los eventos una vez emitidos. Queda pendiente repetir la Tarea 8 completa (grabar una reunión real de punta a punta y confirmar `transcripcion.json`) para verificar que esta corrección resuelve el problema end-to-end, no solo que el indicador ya se encuentra en el DOM.


- Reemplazo de "You" por nombre real con sufijo `" (You)"`: cubierto en `speaker-label-reconciler.js` (Tarea 1) y verificado end-to-end en `SessionWriter` (Tarea 7).
- Fallback automático si `__soy.data` no está disponible: cubierto (Tarea 1, tests de "no labels" y "no match"; Tarea 2, todos los `return null`).
- No tocar la atribución de otros hablantes cuando ya funciona: cubierto — el reconciler solo reemplaza el `speaker` cuando encuentra una ventana que matchea; si no hay ninguna, se preserva el original tal cual venía del panel de captions.
- No romper `CaptionParser` ni sus tests existentes: cubierto — no se modifica ese archivo.
- Riesgos de memoria/duplicación de observers señalados por Codex: cubiertos con el `WeakSet` en `speaker-observer.js` (Tarea 3).
- Timestamps compartiendo base de tiempo: cubierto — tanto `meet-caption-observer.js` (ISOLATED) como `speaker-observer.js` (MAIN) corren en la misma pestaña/proceso de renderer y usan `Date.now()` directamente, sin pasar por serialización que pierda precisión.
- Endurecer la validación de `sessionId` en los mensajes `postMessage`: **fuera de alcance**, documentado arriba como riesgo preexistente no resuelto por este plan.
