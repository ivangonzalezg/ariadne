# Finalización robusta de sesión al cerrar/dejar la reunión — Implementation Plan

> **Para quien ejecute este plan:** este proyecto NO usa `superpowers:subagent-driven-development` ni `superpowers:executing-plans`. Por las reglas del proyecto (`CLAUDE.md`), cada tarea se delega a Codex (agente `codex:codex-rescue`), una por una, referenciando este archivo y el número de tarea exacto. Claude revisa lo que Codex devuelve antes de pasar a la siguiente tarea. Este plan pasó por dos rondas de revisión de Codex antes de ejecutarse: una de arquitectura general y otra del documento final tarea por tarea — sus hallazgos ya están incorporados abajo.

**Goal:** Cuando el usuario cierra la pestaña de Meet, navega a otra URL, o deja la reunión sin cerrar la pestaña, la grabación en curso debe finalizarse y guardarse (aunque sea con los datos parciales capturados hasta ese momento) — hoy, en la mayoría de esos casos, no se guarda nada.

**Causa raíz (diagnosticada, confirmada por revisión de Codex):**
1. El único disparador de cierre de sesión hoy es `window.addEventListener("pagehide", ...)` en `meet-detector.js`, que vive en la MISMA pestaña que se está cerrando. Ese handler dispara una cadena async de varios pasos (parar `MediaRecorder`s → esperar el último chunk → 2 saltos de mensajería → `SessionWriter.finalize()` async en el offscreen document) que la plataforma web **no garantiza** que termine de correr antes de que el proceso de la pestaña muera.
2. No existe ninguna detección de "el usuario dejó la reunión pero la pestaña sigue abierta" (ej. botón "Salir de la llamada" en Meet, que no cierra la pestaña) — la grabación sigue corriendo indefinidamente hasta que alguien aprieta "Stop" a mano.

**Cómo lo resuelve un competidor comparable (Fireflies.ai, decompilado legítimamente desde su `.crx` público, investigación ya hecha antes en este proyecto):** su **service worker** (contexto separado que sobrevive al cierre de la pestaña) escucha `chrome.tabs.onRemoved` y `chrome.webNavigation.onCommitted` (para refresh/navegación), y desde ahí dispara la finalización directamente — sin depender de que la pestaña que se está muriendo alcance a avisar nada.

**Architecture:** Replicamos ese mecanismo, adaptado a nuestra arquitectura. `src/background/service-worker.js` ya trackea `sessionId → tabId` en un `Map` en memoria (`activeSessionTabIds`, sin usar para esto todavía) — se reemplaza por un registro persistido en `chrome.storage.local`, serializado con una cola interna para evitar que dos registros concurrentes se pisen (un `Map` en memoria se pierde si Chrome descarga el service worker por inactividad, algo que MV3 hace agresivamente; `chrome.storage.local` sobrevive a eso). Con ese registro durable, se agregan dos listeners nuevos en el service worker — `chrome.tabs.onRemoved` (cierre de pestaña) y `chrome.webNavigation.onCommitted` con `frameId === 0` (navegación/refresh del documento principal, requiere el permiso `webNavigation`) — que, si encuentran una sesión activa para esa pestaña, le mandan directamente `asterion:session-ended` al offscreen document, sin pasar por la pestaña. Como ese camino de emergencia no tiene acceso al historial real de mute/unmute (vivía en la pestaña que ya se fue), `SessionWriter` acepta un `muteManifest` nulo y lo reemplaza por un marcador explícito de "no se pudo reconstruir" en vez de fingir silenciosamente que el mic nunca se desmuteó. Como ahora puede haber más de un camino que intente finalizar la misma sesión (el normal vía `pagehide`, el de `tabs.onRemoved`, y el de `webNavigation.onCommitted`, y no hay garantía de que solo uno de ellos dispare), se agregan DOS capas de protección contra duplicados: `SessionWriter.finalize()` se vuelve idempotente (siempre devuelve la misma promesa), y el offscreen document deduplica el manejo de `asterion:session-ended` por sesión (para no reencadenar el envío de `asterion:session-finalized` — que duplicaría la entrada en el historial — aunque `finalize()` ya sea idempotente). Por separado, se agrega una detección liviana (polling, no `MutationObserver`, para no sumar otro observer de árbol completo corriendo durante toda la reunión — ya existe uno en `speaker-observer.js`) de "la reunión terminó" en `meet-detector.js` para auto-parar la grabación cuando el usuario deja la llamada sin cerrar la pestaña — ese caso no tiene el problema de carrera (la pestaña sigue viva), así que reutiliza la cadena de parada normal sin cambios.

**Riesgos conocidos, deliberadamente fuera de alcance de este plan (señalados por Codex, documentar en `asterion-alcance.md` al terminar):**
- **Chunks en tránsito:** el camino de emergencia solo puede salvar los chunks de audio/video que ya llegaron y se escribieron en el offscreen document antes del cierre — el último chunk (producido recién al llamar `recorder.stop()`) puede perderse si la pestaña muere antes de que ese último `postMessage`/`chrome.runtime.sendMessage` salga. No hay barrera de confirmación (`seq` ack) entre MAIN world y el offscreen document hoy; agregarla es un plan aparte.
- **Carrera de arranque:** si la pestaña se cierra en la fracción de segundo entre `asterion:session-starting` y que el offscreen document efectivamente registre la sesión (`sessions.set(...)` en `offscreen.js`), el mensaje de emergencia puede llegar antes de que exista el writer y se descarta en silencio. Ventana extremadamente angosta en la práctica (el usuario tendría que cerrar la pestaña en los primeros milisegundos de haber empezado a grabar), no se resuelve acá.
- **Crash del navegador, crash del proceso de la extensión/offscreen, o cierre completo de Chrome:** este plan cubre cierre/navegación de pestaña vía Chrome, no terminación anómala de procesos. Una recuperación completa (marcador durable de "grabación en curso" + reconciliación de carpetas huérfanas al abrir el historial) es una mejora más grande, no incluida acá.
- **Último snapshot de captions/speaker labels:** igual que los chunks, el último snapshot que solo vivía en la memoria de la pestaña (sin haber llegado al offscreen document todavía) se pierde si la pestaña muere antes de mandarlo.
- **Persistencia del registro entre reinicios del service worker:** la cola de serialización que evita que dos registros concurrentes se pisen vive en memoria del propio service worker — si el worker se reinicia a mitad de una escritura pendiente, esa escritura puntual puede perderse (aunque el registro durable en `chrome.storage.local` sigue siendo muchísimo más resistente que el `Map` en memoria que reemplaza). Una cola verdaderamente resistente a reinicios del worker es una mejora mayor, no incluida acá.

**Tech Stack:** JavaScript vanilla (ES modules), `chrome.storage.local`, `chrome.tabs.onRemoved`, `chrome.webNavigation.onCommitted`, Manifest V3, Vitest.

---

### Task 1: Registro persistido de sesiones activas en `chrome.storage.local`

**Files:**
- Modify: `src/background/service-worker.js`
- Test: `src/background/service-worker.test.js` (nuevo)

Reemplaza el `Map` en memoria `activeSessionTabIds` (que se pierde si Chrome descarga el service worker) por funciones que leen/escriben `chrome.storage.local`, serializadas con una cola interna para que dos registros concurrentes no se pisen.

- [ ] **Step 1: Escribir los tests (deben fallar — las funciones no existen todavía)**

```js
// src/background/service-worker.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

function mockChromeStorage() {
  const store = {};
  return {
    local: {
      get: vi.fn((defaults) => {
        const keys = Object.keys(defaults);
        const result = {};
        for (const key of keys) result[key] = key in store ? store[key] : defaults[key];
        return Promise.resolve(result);
      }),
      set: vi.fn((values) => {
        Object.assign(store, values);
        return Promise.resolve();
      }),
    },
    __store: store,
  };
}

function baseChromeMock() {
  return {
    storage: mockChromeStorage(),
    runtime: { onMessage: { addListener: () => {} }, getContexts: vi.fn().mockResolvedValue([{}]), getURL: (p) => p },
    tabs: { onRemoved: { addListener: () => {} } },
    webNavigation: { onCommitted: { addListener: () => {} } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  };
}

describe("active session registry", () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.chrome = baseChromeMock();
  });

  it("registerActiveSession stores sessionId, tabId and meetingTitle", async () => {
    const { registerActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");
    expect(await findActiveSessionIdsForTab(42)).toEqual(["session-1"]);
  });

  it("findActiveSessionIdsForTab returns an empty array when no session matches", async () => {
    const { findActiveSessionIdsForTab } = await import("./service-worker.js");
    expect(await findActiveSessionIdsForTab(999)).toEqual([]);
  });

  it("unregisterActiveSession removes the entry", async () => {
    const { registerActiveSession, unregisterActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");
    await unregisterActiveSession("session-1");
    expect(await findActiveSessionIdsForTab(42)).toEqual([]);
  });

  it("supports multiple sessions registered for different tabs sequentially", async () => {
    const { registerActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");
    await registerActiveSession("session-2", 43, "1:1");
    expect(await findActiveSessionIdsForTab(42)).toEqual(["session-1"]);
    expect(await findActiveSessionIdsForTab(43)).toEqual(["session-2"]);
  });

  it("keeps both sessions when two are registered concurrently (no lost update)", async () => {
    const { registerActiveSession, findActiveSessionIdsForTab } = await import("./service-worker.js");
    await Promise.all([
      registerActiveSession("session-1", 42, "Daily sync"),
      registerActiveSession("session-2", 43, "1:1"),
    ]);
    expect(await findActiveSessionIdsForTab(42)).toEqual(["session-1"]);
    expect(await findActiveSessionIdsForTab(43)).toEqual(["session-2"]);
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run src/background/service-worker.test.js`
Expected: FAIL (`registerActiveSession`/`findActiveSessionIdsForTab`/`unregisterActiveSession` no existen todavía, o no están exportadas).

- [ ] **Step 3: Implementar el registro persistido**

En `src/background/service-worker.js`, reemplazar la línea 3 (`const activeSessionTabIds = new Map();`) por:

```js
const ACTIVE_SESSIONS_KEY = "activeRecordingSessions";

// Serializa las lecturas/escrituras del registro para que dos llamadas
// concurrentes (ej. dos reuniones arrancando casi al mismo tiempo) no se
// pisen: sin esto, dos "get -> mutar -> set" en paralelo podrían leer el
// mismo estado viejo y la segunda escritura descartaría lo que agregó la
// primera.
let registryQueue = Promise.resolve();

function withRegistryLock(mutator) {
  const result = registryQueue.then(async () => {
    const { [ACTIVE_SESSIONS_KEY]: activeSessions } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
    mutator(activeSessions);
    await chrome.storage.local.set({ [ACTIVE_SESSIONS_KEY]: activeSessions });
  });
  registryQueue = result.catch(() => {});
  return result;
}

export function registerActiveSession(sessionId, tabId, meetingTitle) {
  return withRegistryLock((activeSessions) => {
    activeSessions[sessionId] = { tabId, meetingTitle };
  });
}

export function unregisterActiveSession(sessionId) {
  return withRegistryLock((activeSessions) => {
    delete activeSessions[sessionId];
  });
}

export async function findActiveSessionIdsForTab(tabId) {
  const { [ACTIVE_SESSIONS_KEY]: activeSessions } = await chrome.storage.local.get({ [ACTIVE_SESSIONS_KEY]: {} });
  return Object.entries(activeSessions)
    .filter(([, session]) => session.tabId === tabId)
    .map(([sessionId]) => sessionId);
}
```

Reemplazar el handler de `asterion:session-starting` existente (dentro del listener de `chrome.runtime.onMessage`) para encadenar el registro ANTES de crear el offscreen document (minimiza la ventana de la "carrera de arranque" documentada arriba), y el de `asterion:session-finalized` para desregistrar:

```js
if (message.type === "asterion:session-starting") {
  registerActiveSession(message.sessionId, sender.tab?.id ?? null, message.meetingTitle)
    .then(() => ensureOffscreenDocument())
    .then(() => {
      chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId: message.sessionId, meetingTitle: message.meetingTitle });
    });
} else if (message.type === "asterion:session-finalized") {
  unregisterActiveSession(message.sessionId);
  appendToHistory(message);
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/background/service-worker.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Correr toda la suite para descartar regresiones**

Run: `npx vitest run`
Expected: PASS en todos los archivos.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.js src/background/service-worker.test.js
git commit -m "feat: persist the active-session registry in chrome.storage.local"
```

---

### Task 2: `SessionWriter.finalize()` idempotente

**Files:**
- Modify: `src/storage/session-writer.js`
- Modify: `src/storage/session-writer.test.js`

Con más de un camino que puede intentar finalizar la misma sesión (el normal y los de emergencia de las Tareas 5 y 6), `finalize()` tiene que devolver siempre el mismo resultado sin repetir trabajo (cerrar streams dos veces, reescribir manifest, disparar conversiones por duplicado) si se lo llama más de una vez.

- [ ] **Step 1: Escribir el test que prueba la idempotencia (debe fallar)**

Agregar a `src/storage/session-writer.test.js`, dentro de `describe("SessionWriter conversion flow", ...)`, después del test `"does not write any transcript file when there were no captions"`:

```js
it("finalize() called twice returns the same result and does not run conversions twice", async () => {
  ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
  const writer = await createWriter({ audio: true, video: false });
  const finished = finishConversions(writer);

  const [first, second] = await Promise.all([
    writer.finalize({ muteManifest: { intervals: [] } }),
    writer.finalize({ muteManifest: { intervals: [] } }),
  ]);
  await finished;

  expect(first).toEqual(second);
  expect(ffmpeg.runFfmpegJob).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: FAIL en el nuevo test (hoy `finalize()` llamado dos veces corre todo dos veces, `ffmpeg.runFfmpegJob` se llama 2 veces en vez de 1).

- [ ] **Step 3: Implementar la idempotencia**

En `src/storage/session-writer.js`, agregar `this._finalizePromise = null;` al constructor, junto a `this.streamsUsed = new Set();` (antes de `this.ready = this._init();`):

```js
    this.streamsUsed = new Set();
    this._finalizePromise = null;
    this.ready = this._init();
```

Renombrar el método `finalize` actual a `_finalizeOnce` (mismo cuerpo, sin cambios en la lógica interna todavía) y agregar un `finalize` público que memoiza:

```js
  finalize(args) {
    if (!this._finalizePromise) this._finalizePromise = this._finalizeOnce(args);
    return this._finalizePromise;
  }

  async _finalizeOnce({ muteManifest, endedAt }) {
    // ... (todo el cuerpo que hoy tiene `finalize`, sin cambios en esta tarea)
  }
```

- [ ] **Step 4: Correr los tests y verificar que todos pasan**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: PASS (todos, incluido el nuevo).

- [ ] **Step 5: Commit**

```bash
git add src/storage/session-writer.js src/storage/session-writer.test.js
git commit -m "feat: make SessionWriter.finalize() idempotent"
```

---

### Task 3: Deduplicar `asterion:session-ended` en el offscreen document

**Files:**
- Modify: `src/offscreen/offscreen.js`
- Test: `src/offscreen/offscreen.test.js` (nuevo)

`SessionWriter.finalize()` ya es idempotente (Tarea 2) — pero eso no alcanza por sí solo: si `asterion:session-ended` llega dos veces para la misma sesión (posible una vez que las Tareas 5/6 agreguen más caminos que pueden dispararlo), el offscreen document hoy le encadena un `.then(...)` NUEVO a la promesa cacheada cada vez, y ese `.then` manda `asterion:session-finalized` — así que el mensaje saldría dos veces igual, aunque `finalize()` internamente no haga el trabajo dos veces. Eso duplicaría la entrada en el historial (`appendToHistory` en `service-worker.js` corre una vez por cada `session-finalized` que llega).

- [ ] **Step 1: Escribir el test (debe fallar)**

```js
// src/offscreen/offscreen.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

const writerState = vi.hoisted(() => ({ instances: [] }));

vi.mock("../storage/session-writer.js", () => ({
  SessionWriter: class {
    constructor({ sessionId }) {
      this.sessionId = sessionId;
      this.ready = Promise.resolve();
      this.finalizeCalls = 0;
      this.onConversionsFinished = null;
      writerState.instances.push(this);
    }
    onCaptionSnapshot() {}
    onSpeakerLabel() {}
    writeChunk() {
      return Promise.resolve();
    }
    async finalize() {
      this.finalizeCalls += 1;
      return { sessionId: this.sessionId, folderName: "x" };
    }
  },
}));

describe("offscreen session-ended deduplication", () => {
  let messageListener;

  beforeEach(() => {
    vi.resetModules();
    writerState.instances = [];
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => { messageListener = fn; } },
        sendMessage: vi.fn(),
      },
    };
  });

  it("only finalizes once and sends session-finalized once when session-ended arrives twice", async () => {
    await import("./offscreen.js");
    await messageListener({ type: "asterion:session-starting", sessionId: "session-1", meetingTitle: "Daily" }, {});
    await messageListener({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null, endedAt: 1000 }, {});
    await messageListener({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null, endedAt: 1000 }, {});
    await Promise.resolve();
    await Promise.resolve();

    const writer = writerState.instances[0];
    expect(writer.finalizeCalls).toBe(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/offscreen/offscreen.test.js`
Expected: FAIL (`chrome.runtime.sendMessage` se llama 2 veces).

- [ ] **Step 3: Implementar la deduplicación**

En `src/offscreen/offscreen.js`, agregar junto a `const sessions = new Map();`:

```js
const finalizingSessionIds = new Set();
```

Reemplazar el bloque `else if (message.type === "asterion:session-ended") { ... }` existente por:

```js
  } else if (message.type === "asterion:session-ended") {
    const writer = sessions.get(message.sessionId);
    if (!writer || finalizingSessionIds.has(message.sessionId)) return;
    finalizingSessionIds.add(message.sessionId);
    writer.onConversionsFinished = () => {
      sessions.delete(message.sessionId);
      finalizingSessionIds.delete(message.sessionId);
    };
    writer
      .finalize({ muteManifest: message.muteManifest, endedAt: message.endedAt })
      .then((meta) => {
        chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...meta });
      })
      .catch((error) => {
        console.error("[Ariadne] Error finalizando la sesión:", error);
        sessions.delete(message.sessionId);
        finalizingSessionIds.delete(message.sessionId);
      });
  }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/offscreen/offscreen.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Correr toda la suite**

Run: `npx vitest run`
Expected: PASS en todos los archivos.

- [ ] **Step 6: Commit**

```bash
git add src/offscreen/offscreen.js src/offscreen/offscreen.test.js
git commit -m "feat: deduplicate asterion:session-ended handling in the offscreen document"
```

---

### Task 4: `muteManifest` degradado cuando falta

**Files:**
- Modify: `src/storage/session-writer.js`
- Modify: `src/storage/session-writer.test.js`

El camino de emergencia (Tareas 5 y 6) no tiene forma de reconstruir el historial real de mute/unmute — vivía en la pestaña que ya se cerró. En vez de escribir `muteManifest: null` (que podría interpretarse como "el mic nunca se desmuteó", falso) o reventar, se escribe un marcador explícito de "no se pudo reconstruir este dato".

- [ ] **Step 1: Escribir el test (debe fallar)**

Agregar a `src/storage/session-writer.test.js`, junto al test de la Tarea 2:

```js
it("writes a degraded muteManifest marker when none is provided (emergency finalize path)", async () => {
  ffmpeg.runFfmpegJob.mockResolvedValue(new Uint8Array([9]));
  const writer = await createWriter({ audio: true, video: false });
  const finished = finishConversions(writer);

  await writer.finalize({ muteManifest: null });
  await finished;

  expect(manifestOf(writer).muteManifest).toEqual({ intervals: [], degraded: true });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: FAIL (`manifestOf(writer).muteManifest` da `null`, no el objeto degradado).

- [ ] **Step 3: Implementar el fallback**

En `_finalizeOnce` (el método renombrado en la Tarea 2), al principio del cuerpo, agregar:

```js
  async _finalizeOnce({ muteManifest, endedAt }) {
    // Cuando la sesión se finaliza desde un camino de emergencia (cierre de
    // pestaña/navegación, ver service-worker.js) no hay forma de reconstruir
    // el historial real de mute/unmute — vivía en la pestaña que ya se fue.
    // degraded:true dice explícitamente "no se pudo reconstruir este dato",
    // nunca "el mic nunca se desmuteó" (que sería lo que {intervals: []}
    // solo, sin la marca, parecería implicar).
    const resolvedMuteManifest = muteManifest ?? { intervals: [], degraded: true };
    // Se usa el momento real en que el usuario detuvo la grabación (capturado en
    // MainWorldSession.stop()), no cuándo finalize() llegó a ejecutarse acá -
    // entre medio hay envíos de mensajes y cierres de archivo que pueden demorar.
    this.endedAt = endedAt ?? Date.now();
    await this.ready;
```

Hay **2** apariciones más de la variable `muteManifest` dentro del resto del cuerpo de `_finalizeOnce` (no en la firma del método, que no se toca) — reemplazarlas por `resolvedMuteManifest`:
- En la llamada `await this._writeManifest({ muteManifest, audioConversionStatus: ..., videoConversionStatus: ... });` → pasar `resolvedMuteManifest` en vez de `muteManifest`.
- En la llamada `this.scheduleConversions(muteManifest, this.endedAt);` → pasar `resolvedMuteManifest` en vez de `muteManifest`.

`scheduleConversions` recibe ese valor ya resuelto como su parámetro (sigue llamándose `muteManifest` adentro de esa función, no hace falta renombrarlo ahí) y lo sigue pasando tal cual a las llamadas internas de `_writeManifest` que ya tiene — no hace falta tocar el cuerpo de `scheduleConversions` en sí.

- [ ] **Step 4: Correr los tests y verificar que todos pasan**

Run: `npx vitest run src/storage/session-writer.test.js`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/storage/session-writer.js src/storage/session-writer.test.js
git commit -m "feat: fall back to a degraded muteManifest marker when none is given"
```

---

### Task 5: Finalización de emergencia por cierre de pestaña (`chrome.tabs.onRemoved`)

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/background/service-worker.test.js`

- [ ] **Step 1: Escribir el test (debe fallar)**

Agregar a `src/background/service-worker.test.js`, dentro de un nuevo `describe`:

```js
describe("emergency finalize on tab close", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sends asterion:session-ended for a session whose tab was closed", async () => {
    let onRemovedHandler;
    const sendMessage = vi.fn();
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      tabs: { onRemoved: { addListener: (fn) => { onRemovedHandler = fn; } } },
    };

    const { registerActiveSession } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");

    await onRemovedHandler(42);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null })
    );
  });

  it("does nothing when the closed tab has no active session", async () => {
    let onRemovedHandler;
    const sendMessage = vi.fn();
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      tabs: { onRemoved: { addListener: (fn) => { onRemovedHandler = fn; } } },
    };

    await import("./service-worker.js");
    await onRemovedHandler(999);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run src/background/service-worker.test.js`
Expected: FAIL en los dos tests nuevos (no existe todavía el listener de `chrome.tabs.onRemoved` para esto).

- [ ] **Step 3: Implementar el listener**

Al final de `src/background/service-worker.js`, agregar:

```js
function finalizeAbandonedSession(sessionId) {
  // No se desregistra acá: si el envío del mensaje o la finalización fallan,
  // se pierde la única referencia durable para poder reintentar más adelante.
  // El registro se limpia como siempre, desde el handler de
  // "asterion:session-finalized" que ya corre cuando el offscreen document
  // termina de verdad (ver Tarea 1).
  ensureOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      type: "asterion:session-ended",
      sessionId,
      muteManifest: null,
      endedAt: Date.now(),
    });
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessionIds = await findActiveSessionIdsForTab(tabId);
  for (const sessionId of sessionIds) {
    finalizeAbandonedSession(sessionId);
  }
});
```

- [ ] **Step 4: Correr los tests y verificar que todos pasan**

Run: `npx vitest run src/background/service-worker.test.js`
Expected: PASS (7 tests: los 5 de la Tarea 1 + los 2 nuevos).

- [ ] **Step 5: Correr toda la suite**

Run: `npx vitest run`
Expected: PASS en todos los archivos.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.js src/background/service-worker.test.js
git commit -m "feat: finalize abandoned recordings when their tab closes"
```

---

### Task 6: Finalización de emergencia por navegación/refresh (`chrome.webNavigation.onCommitted`)

**Files:**
- Modify: `manifest.json`
- Modify: `src/background/service-worker.js`
- Modify: `src/background/service-worker.test.js`

Cubre el caso de que el usuario recargue la pestaña de Meet o navegue a otra URL sin cerrar la pestaña — el documento viejo (con la sesión de grabación corriendo) desaparece igual que si hubiera cerrado la pestaña, pero `chrome.tabs.onRemoved` no dispara en ese caso (la pestaña sigue existiendo, solo cambió de documento).

- [ ] **Step 1: Agregar el permiso `webNavigation`**

En `manifest.json`, en el array `"permissions"` (línea 14), agregar `"webNavigation"` — no hace falta ningún `host_permissions` adicional, ya tenemos `host_permissions: ["https://meet.google.com/*"]`:

```json
  "permissions": ["storage", "offscreen", "unlimitedStorage", "downloads", "webNavigation"],
```

- [ ] **Step 2: Escribir el test (debe fallar)**

Agregar a `src/background/service-worker.test.js`, dentro del mismo `describe("emergency finalize on tab close", ...)`:

```js
  it("sends asterion:session-ended when the top frame of a recording tab navigates away", async () => {
    let onCommittedHandler;
    const sendMessage = vi.fn();
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      webNavigation: { onCommitted: { addListener: (fn) => { onCommittedHandler = fn; } } },
    };

    const { registerActiveSession } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");

    await onCommittedHandler({ tabId: 42, frameId: 0 });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "asterion:session-ended", sessionId: "session-1", muteManifest: null })
    );
  });

  it("ignores onCommitted events for subframes (frameId !== 0)", async () => {
    let onCommittedHandler;
    const sendMessage = vi.fn();
    globalThis.chrome = {
      ...baseChromeMock(),
      runtime: { ...baseChromeMock().runtime, sendMessage },
      webNavigation: { onCommitted: { addListener: (fn) => { onCommittedHandler = fn; } } },
    };

    const { registerActiveSession } = await import("./service-worker.js");
    await registerActiveSession("session-1", 42, "Daily sync");

    await onCommittedHandler({ tabId: 42, frameId: 7 });

    expect(sendMessage).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Correr los tests y verificar que fallan**

Run: `npx vitest run src/background/service-worker.test.js`
Expected: FAIL en los dos tests nuevos.

- [ ] **Step 4: Implementar el listener**

Después del bloque de `chrome.tabs.onRemoved.addListener(...)` agregado en la Tarea 5, agregar:

```js
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const sessionIds = await findActiveSessionIdsForTab(details.tabId);
  for (const sessionId of sessionIds) {
    finalizeAbandonedSession(sessionId);
  }
});
```

- [ ] **Step 5: Correr los tests y verificar que todos pasan**

Run: `npx vitest run src/background/service-worker.test.js`
Expected: PASS (9 tests).

- [ ] **Step 6: Correr toda la suite**

Run: `npx vitest run`
Expected: PASS en todos los archivos.

- [ ] **Step 7: Commit**

```bash
git add manifest.json src/background/service-worker.js src/background/service-worker.test.js
git commit -m "feat: finalize abandoned recordings on top-frame navigation away from Meet"
```

---

### Task 7: Auto-parar la grabación cuando se deja la reunión sin cerrar la pestaña

**Files:**
- Modify: `src/content/meet-detector.js`

Este caso no tiene el problema de carrera de las tareas anteriores (la pestaña sigue viva) — solo hace falta detectar que `isInActiveMeeting()` pasó a `false` mientras se está grabando, y llamar a la misma `stopRecording()` que ya usa el botón "Stop" manual. Se usa polling liviano (`setInterval`, no `MutationObserver`) porque ya existe un `MutationObserver` de árbol completo corriendo durante toda la grabación en `src/webrtc-bootstrap/speaker-observer.js` — sumar un segundo observer de árbol completo, ejecutando `isInActiveMeeting()` (que recorre todos los `<i>` de la página) en cada mutación del DOM, es innecesariamente costoso para algo que no necesita reaccionar instantáneamente.

- [ ] **Step 1: Agregar el polling**

En `src/content/meet-detector.js`, junto a las otras variables de estado de observers (`let stopMuteObserver = () => {};` / `let stopCaptionObserver = () => {};`), agregar:

```js
let stopMeetingEndObserver = () => {};
const MEETING_END_POLL_INTERVAL_MS = 3000;
```

Agregar la función, junto a `waitForMeeting()` (puede ir justo antes):

```js
function observeMeetingEnd() {
  // Chequeo inicial inmediato: cubre el caso de que el usuario ya se haya
  // ido de la reunión mientras `startRecording()` todavía estaba esperando
  // `enableCaptionsAndObserve(...)`, antes de que este polling arrancara.
  if (!isInActiveMeeting()) {
    debugLog("[Ariadne:debug] se detectó que la reunión terminó (chequeo inicial), deteniendo grabación automáticamente");
    stopRecording();
    return () => {};
  }

  const intervalId = setInterval(() => {
    if (!isInActiveMeeting()) {
      clearInterval(intervalId);
      debugLog("[Ariadne:debug] se detectó que la reunión terminó, deteniendo grabación automáticamente");
      stopRecording();
    }
  }, MEETING_END_POLL_INTERVAL_MS);
  return () => clearInterval(intervalId);
}
```

En `cleanupObservers()`, agregar la limpieza junto a las otras dos:

```js
function cleanupObservers() {
  stopMuteObserver();
  stopCaptionObserver();
  stopMeetingEndObserver();
  stopMuteObserver = () => {};
  stopCaptionObserver = () => {};
  stopMeetingEndObserver = () => {};
}
```

Al final de `startRecording()` (después de la línea `stopCaptionObserver = cleanup ?? (() => {});`), agregar:

```js
  stopMeetingEndObserver = observeMeetingEnd();
```

- [ ] **Step 2: Verificar que el build sigue funcionando**

Run: `npm run build:content`
Expected: termina sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/content/meet-detector.js
git commit -m "feat: auto-stop recording when the user leaves the meeting"
```

(No hay test unitario nuevo para este archivo — `meet-detector.js` es código de wiring sin tests hoy, como el resto de sus responsabilidades. Se verifica manualmente en la Tarea 8, incluyendo específicamente el caso de dejar la reunión mientras las captions todavía se están inicializando.)

---

### Task 8: Verificación manual en una reunión real

**Files:** ninguno (solo verificación).

Los escenarios que este plan busca arreglar no se pueden probar sin una reunión real. Quien ejecute esta tarea debe reportar explícitamente qué pudo confirmar y qué no.

- [ ] **Step 1: Cerrar la pestaña a mitad de una grabación.** Empezar a grabar una reunión, hablar unos segundos (para tener transcripción), y cerrar la pestaña directamente (no apretar "Stop"). Esperar unos segundos, abrir el historial (`chrome://extensions` → popup → "Ver historial", o abrir `history.html` directo) y confirmar que la reunión aparece, con al menos el audio guardado (`audio-reunion.webm`, puede no tener conversión a mp3 todavía si el offscreen document tardó en procesar la cola de conversión) y `manifest.json` con `muteManifest: { intervals: [], degraded: true }`.
- [ ] **Step 2: Recargar la pestaña a mitad de una grabación.** Igual que el paso 1, pero en vez de cerrar la pestaña, recargarla (F5). Confirmar el mismo resultado.
- [ ] **Step 3: Salir de la llamada sin cerrar la pestaña.** Empezar a grabar, hablar unos segundos, y clickear "Salir de la llamada" en la UI de Meet (sin cerrar la pestaña ni recargar). Confirmar que el banner cambia de estado solo (sin apretar "Stop" a mano, dentro de los `~3` segundos del polling) y que la reunión aparece en el historial con `muteManifest` real (no degradado, ya que en este camino la pestaña sigue viva y puede completar la cadena normal).
- [ ] **Step 4: Dejar la reunión mientras las captions todavía se están inicializando.** Empezar a grabar y, apenas arranque (antes de que pase medio segundo), clickear "Salir de la llamada" de inmediato. Confirmar que igual se detecta y se guarda algo (el chequeo inicial inmediato del Step 1 de la Tarea 7 debería cubrir esto).
- [ ] **Step 5: Caso ya cubierto (regresión).** Grabar una reunión completa y apretar "Stop" a mano, como siempre. Confirmar que sigue funcionando exactamente igual que antes de este plan.
- [ ] **Step 6: Reportar** qué se verificó con éxito, qué cayó al camino degradado, y cualquier caso que no se haya podido probar (ej. si no se pudo forzar un cierre de pestaña lo suficientemente rápido como para perder el último chunk y confirmar el límite conocido documentado arriba).
