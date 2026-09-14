# Asterion — Captura Automática (v2, post-tabCapture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensión de Chrome MV3 que, para una reunión de Google Meet, captura automáticamente (sin clic) audio de la reunión, audio propio y transcripción interceptando el WebRTC interno de Meet, ofrece video como función aparte con consentimiento explícito, y guarda todo localmente.

**Reemplaza a:** [2026-09-13-meet-capture-prototype.md](2026-09-13-meet-capture-prototype.md), cuyas Tasks 9-13 (basadas en `chrome.tabCapture` + offscreen document) quedaron obsoletas al descubrir que esa API no permite auto-inicio. Las Tasks 1-3 y 5.5-8 de ese plan (scaffolding, lógica pura, banner/observadores de DOM) se reutilizan aquí con ajustes menores (sin pausa).

**Arquitectura:** Content script `MAIN world` (`document_start`) que parchea `RTCPeerConnection`/`getUserMedia` para interceptar audio de Meet y graba con `MediaRecorder`; content script `ISOLATED world` para detección/banner/DOM, puenteando al `MAIN world` vía `postMessage` y al service worker vía `chrome.runtime`; service worker como control plane sin media; popup como superficie de estado/transcripción/config.

**Tech Stack:** JavaScript vanilla, Manifest V3 (content script `world: "MAIN"`), Web Audio API, MediaRecorder, File System Access API, Vitest.

**PRD de referencia:** [asterion-alcance.md](../../../asterion-alcance.md).

---

## Task 1: Project scaffolding ✅

Idéntico al Task 1 + Task 1.5 del plan viejo (reutilizado sin cambios: no dependían de `tabCapture` ni de pausa). Implementado por Codex, commiteado en `bdbdb76`.

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "asterion",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "build:content": "esbuild src/content/meet-detector.js --bundle --outfile=dist/content.bundle.js",
    "build:webrtc": "esbuild src/webrtc-bootstrap/bootstrap.js --bundle --outfile=dist/webrtc-bootstrap.bundle.js",
    "build": "npm run build:content && npm run build:webrtc"
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

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json vitest.config.js .gitignore
git commit -m "chore: scaffold Asterion extension project"
```

---

## Task 2: Mute-interval manifest logic ✅ (commit `5c74495`)

Reutilizado sin cambios del Task 2 del plan viejo — la lógica de intervalos de mute no dependía de `tabCapture` ni de pausa.

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

## Task 3: Caption parser logic ✅ (commit `5c74495`)

Reutilizado del Task 3 del plan viejo, con el test ya corregido (Codex había encontrado un bug: al segundo snapshot de "Ana" le faltaba el primero, dejando un `startMs` inconsistente).

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

## Task 4: Arquitectura de storage cross-origin (decisión) ✅

**Decisión (con Codex, ver conversación de arranque de esta sesión):** un `FileSystemDirectoryHandle` **no es transferible entre orígenes bajo ninguna circunstancia** — el spec de File System Access lo prohíbe explícitamente, no es un límite de qué canal de mensajería se use. El handle elegido en el popup (origen `chrome-extension://<id>`) nunca puede usarse directamente desde el content script inyectado en `https://meet.google.com`.

**Arquitectura resultante:**
- Vuelve **un offscreen document**, pero solo como **sumidero de escritura** (sin `MediaRecorder`, sin lógica de sesión de grabación — eso vive en el bootstrap `MAIN world`, Task 6). Razón de creación: `"BLOBS"` (sin el cierre automático a los 30s que sí aplica a `"AUDIO_PLAYBACK"`).
- El offscreen document lee el handle persistido en el IndexedDB de la extensión (mismo origen que el popup), verifica permiso `readwrite` con `queryPermission` antes de escribir, y mantiene un `FileSystemWritableFileStream` abierto por archivo mientras dura la sesión.
- **No se manda un blob final gigante.** Cada `MediaRecorder` (en el bootstrap `MAIN world`) usa un timeslice corto (ej. 1000ms); cada chunk de `ondataavailable` se convierte a `ArrayBuffer` (`await blob.arrayBuffer()`) — evita depender de soporte de `Blob` en `chrome.runtime` messaging, que solo existe en versiones muy recientes de Chrome (148+) detrás de un opt-in de manifest. El content script `ISOLATED world` reenvía cada `ArrayBuffer` (con `sessionId` + número de secuencia) al offscreen document vía `chrome.runtime.sendMessage`, muy por debajo del límite de 64 MiB por mensaje.
- El offscreen document escribe cada chunk en orden (validando el número de secuencia, defensivo ante reordenamiento) con `writable.write(chunk)`. El texto de transcripción y el manifiesto de mute (JSON, chicos) se mandan completos al finalizar la sesión, no por chunks.
- Si el permiso de la carpeta raíz ya no está vigente, el offscreen document no debe intentar re-pedirlo por su cuenta (no tiene gesto de usuario) — debe avisar al popup para que el usuario lo renueve ahí.

Esto reemplaza el uso de `chrome.tabCapture`/`chrome.offscreen` como plano de *captura* del plan viejo: el offscreen document ya no posee streams ni recorders, solo persiste lo que el `MAIN world` ya grabó.

---

## Task 5: Manifest.json completo

**Files:**
- Create: `manifest.json`

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Asterion — Captura de Reuniones",
  "version": "0.1.0",
  "description": "Captura local automática de transcripción, audio y video de reuniones de Google Meet.",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "offscreen", "scripting"],
  "host_permissions": ["https://meet.google.com/*"],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["dist/webrtc-bootstrap.bundle.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
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

Notas: sin `"tabCapture"` ni `"activeTab"` (ya no se usan — la captura es por interceptación de WebRTC, no por APIs de captura de Chrome). Dos content scripts distintos: el de `world: "MAIN"` corre primero (`document_start`) para alcanzar a parchear `RTCPeerConnection` antes de que Meet cree sus conexiones; el normal (`ISOLATED`, implícito) corre después (`document_idle`) para el DOM/UI, igual que en el plan viejo.

- [ ] **Step 2: Manual verification**

Cargar la carpeta del proyecto como extensión sin empaquetar en `chrome://extensions` (con `dist/` ya generado por `npm run build`, aunque los bundles todavía no existan con contenido real hasta las próximas tareas — puede fallar por archivos faltantes, es esperado en este punto).

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: add MV3 manifest with MAIN-world content script for WebRTC interception"
```

---

## Task 6: Bootstrap `MAIN world` — interceptación de WebRTC + grabación ✅ (código commiteado en `cd54e81`; verificación manual con reunión real de Meet — Step 5 — pendiente, ver Task 11)

**Decisiones previas (consulta a Codex, ver conversación de esta sesión):**
- `document_start` + `world: "MAIN"` es confiable para el frame principal — no agregar `all_frames` de forma especulativa; se valida empíricamente si Meet usa subframes con WebRTC propio.
- El parche debe envolver el constructor preservando semántica original (no una subclase que rompa `instanceof`), y ser idempotente con un contador de diagnóstico expuesto.
- **El clic para activar video NO puede cruzar por `postMessage` hacia este mundo** — el salto asíncrono no garantiza que sobreviva la activación transitoria de usuario que exige `getDisplayMedia()`. El manejador de ese clic específico vive acá mismo, en `MAIN world`, escuchando el DOM real directamente (el banner lo renderiza el content script `ISOLATED`, pero el botón de video lleva un atributo `data-asterion-enable-video` que este bootstrap reconoce).

**Files:**
- Create: `src/webrtc-bootstrap/rtc-patch.js`
- Create: `src/webrtc-bootstrap/audio-mixer.js`
- Create: `src/webrtc-bootstrap/session.js`
- Create: `src/webrtc-bootstrap/bootstrap.js`

- [ ] **Step 1: Write `rtc-patch.js`**

```js
// src/webrtc-bootstrap/rtc-patch.js
export const diagnostics = {
  installedAt: Date.now(),
  peerConnectionsCreated: 0,
  remoteAudioTracksSeen: 0,
  micTracksSeen: 0,
};

export function installRtcPatch({ onRemoteAudioTrack, onConnectionClosed }) {
  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) return;

  function PatchedRTCPeerConnection(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    diagnostics.peerConnectionsCreated += 1;

    pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      diagnostics.remoteAudioTracksSeen += 1;
      onRemoteAudioTrack(event.track, pc);
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        onConnectionClosed(pc);
      }
    });

    return pc;
  }

  PatchedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(PatchedRTCPeerConnection, OriginalRTCPeerConnection);
  window.RTCPeerConnection = PatchedRTCPeerConnection;
}

export function installGetUserMediaPatch({ onMicStream }) {
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await originalGetUserMedia(constraints);
    if (constraints && constraints.audio) {
      const [audioTrack] = stream.getAudioTracks();
      if (audioTrack) {
        diagnostics.micTracksSeen += 1;
        onMicStream(stream, audioTrack);
      }
    }
    return stream;
  };
}
```

Nota sobre `PatchedRTCPeerConnection`: al llamarse con `new`, si la función retorna un objeto, ese objeto reemplaza al `this` recién creado (semántica estándar de JS) — así que las conexiones devueltas son instancias reales de `OriginalRTCPeerConnection`, con `instanceof` intacto para el código de Meet.

- [ ] **Step 2: Write `audio-mixer.js`**

```js
// src/webrtc-bootstrap/audio-mixer.js
export class RemoteAudioMixer {
  constructor() {
    this.audioContext = new AudioContext();
    this.destination = this.audioContext.createMediaStreamDestination();
    this.sourceNodesByTrackId = new Map();
  }

  addTrack(track) {
    if (this.sourceNodesByTrackId.has(track.id)) return;
    const trackStream = new MediaStream([track]);
    const sourceNode = this.audioContext.createMediaStreamSource(trackStream);
    sourceNode.connect(this.destination);
    this.sourceNodesByTrackId.set(track.id, sourceNode);
    track.addEventListener("ended", () => this.removeTrack(track.id));
  }

  removeTrack(trackId) {
    const sourceNode = this.sourceNodesByTrackId.get(trackId);
    if (!sourceNode) return;
    sourceNode.disconnect();
    this.sourceNodesByTrackId.delete(trackId);
  }

  get stream() {
    return this.destination.stream;
  }

  async close() {
    await this.audioContext.close();
  }
}
```

- [ ] **Step 3: Write `session.js`**

```js
// src/webrtc-bootstrap/session.js
import { MuteManifest } from "../lib/mute-manifest.js";

const CHUNK_TIMESLICE_MS = 1000;

export class MainWorldSession {
  constructor({ sessionId, remoteAudioStream, micStream, postToIsolated }) {
    this.sessionId = sessionId;
    this.remoteAudioStream = remoteAudioStream;
    this.micStream = micStream;
    this.postToIsolated = postToIsolated;
    this.muteManifest = new MuteManifest({ startedAt: Date.now() });
    this.seq = { meeting: 0, mic: 0, video: 0 };
    this.videoRecorder = null;
    this.videoStream = null;
  }

  start() {
    this.meetingRecorder = this._startRecorder(this.remoteAudioStream, "meeting");
    this.micRecorder = this._startRecorder(this.micStream, "mic");
  }

  _startRecorder(stream, streamLabel) {
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorder.ondataavailable = async (event) => {
      if (event.data.size === 0) return;
      const buffer = await event.data.arrayBuffer();
      this.seq[streamLabel] += 1;
      this.postToIsolated(
        {
          type: "asterion:chunk",
          sessionId: this.sessionId,
          stream: streamLabel,
          seq: this.seq[streamLabel],
          buffer,
        },
        [buffer]
      );
    };
    recorder.start(CHUNK_TIMESLICE_MS);
    return recorder;
  }

  onMicMuted(timestampMs) {
    this.muteManifest.onMuted(timestampMs);
    if (this.micRecorder?.state === "recording") this.micRecorder.pause();
  }

  onMicUnmuted(timestampMs) {
    this.muteManifest.onUnmuted(timestampMs);
    if (this.micRecorder?.state === "paused") this.micRecorder.resume();
  }

  enableVideo(displayStream) {
    if (this.videoRecorder) return;
    this.videoStream = displayStream;
    this.videoRecorder = this._startRecorder(displayStream, "video");
  }

  async stop() {
    this.muteManifest.finalize(Date.now());
    const recorders = [this.meetingRecorder, this.micRecorder, this.videoRecorder].filter(Boolean);
    recorders.forEach((r) => r.stop());
    await Promise.all(
      recorders.map(
        (r) =>
          new Promise((resolve) => {
            r.onstop = resolve;
          })
      )
    );
    this.videoStream?.getTracks().forEach((t) => t.stop());

    this.postToIsolated({
      type: "asterion:session-ended",
      sessionId: this.sessionId,
      muteManifest: this.muteManifest.toJSON(),
    });
  }
}
```

- [ ] **Step 4: Write `bootstrap.js` (entry point)**

```js
// src/webrtc-bootstrap/bootstrap.js
import { installRtcPatch, installGetUserMediaPatch, diagnostics } from "./rtc-patch.js";
import { RemoteAudioMixer } from "./audio-mixer.js";
import { MainWorldSession } from "./session.js";

const mixer = new RemoteAudioMixer();
let micStream = null;
let session = null;

installRtcPatch({
  onRemoteAudioTrack: (track) => mixer.addTrack(track),
  onConnectionClosed: () => {},
});

installGetUserMediaPatch({
  onMicStream: (stream) => {
    micStream = stream;
  },
});

function postToIsolated(message, transfer = []) {
  window.postMessage({ source: "asterion-main-world", ...message }, "*", transfer);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-isolated-world") return;

  if (message.type === "asterion:start-session") {
    if (!micStream) {
      postToIsolated({ type: "asterion:start-failed", sessionId: message.sessionId, reason: "no-mic-stream" });
      return;
    }
    session = new MainWorldSession({
      sessionId: message.sessionId,
      remoteAudioStream: mixer.stream,
      micStream,
      postToIsolated,
    });
    session.start();
    postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });
  } else if (message.type === "asterion:mic-muted") {
    session?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    session?.onMicUnmuted(message.timestampMs);
  } else if (message.type === "asterion:stop-session") {
    session?.stop();
    session = null;
  }
});

// El clic de "activar video" se maneja acá, no vía postMessage desde el mundo ISOLATED
// (ver decisión de Task 6): así el gesto de usuario llega intacto a getDisplayMedia().
document.addEventListener(
  "click",
  async (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-asterion-enable-video]") : null;
    if (!target || !session) return;

    console.log("[Asterion] userActivation.isActive antes de getDisplayMedia:", navigator.userActivation?.isActive);

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        preferCurrentTab: true,
      });
      session.enableVideo(displayStream);
      postToIsolated({ type: "asterion:video-enabled", sessionId: session.sessionId });
    } catch (error) {
      postToIsolated({
        type: "asterion:video-enable-failed",
        sessionId: session.sessionId,
        message: error.message,
      });
    }
  },
  true
);

window.__asterionDiagnostics = diagnostics;
```

- [ ] **Step 5: Manual verification (no automated test posible — WebRTC/AudioContext/MediaRecorder reales requieren una reunión de Meet)**

Con la extensión cargada (aunque el resto de piezas —content script ISOLATED, service worker, popup— todavía no existan, este bootstrap ya debería instalarse solo), entrar a una reunión real de Meet con al menos otro participante hablando, y en la consola de la página (DevTools sobre la pestaña de Meet, no sobre `chrome://extensions`) correr:

```js
window.__asterionDiagnostics
```

Expected: `peerConnectionsCreated > 0`, `remoteAudioTracksSeen > 0` una vez que el otro participante hable, `micTracksSeen > 0` si el propio mic estuvo activo en algún momento. Si estos quedan en 0 después de un rato con audio real fluyendo, el parche no está enganchando a tiempo — es el riesgo de timing marcado en el PRD (sección 8) y hay que investigarlo antes de seguir.

Para validar el gesto de usuario de video: como todavía no hay banner (Task 7), simular el clic manualmente en la consola:

```js
document.body.insertAdjacentHTML("beforeend", '<button data-asterion-enable-video>test</button>');
document.querySelector("[data-asterion-enable-video]").click();
```

Expected: aparece el diálogo nativo de "Allow" de Chrome (confirmando que el gesto llegó vivo), y el log de `userActivation.isActive` debe imprimir `true` justo antes.

- [ ] **Step 6: Commit**

```bash
git add src/webrtc-bootstrap/
git commit -m "feat: intercept Meet WebRTC audio in MAIN world and record sessions"
```

---

## Task 7: Content script `ISOLATED world` — detección, banner, puente

Reutiliza y adapta las Tasks 5.5-8 del plan viejo (selectores, observador de mute, observador de captions) sin el botón de pausa, y agrega el rol de puente entre el bootstrap `MAIN world` (Task 6, vía `postMessage`) y el service worker (vía `chrome.runtime.sendMessage`).

**Files:**
- Create: `src/content/meet-selectors.js`
- Create: `src/content/meet-mute-observer.js`
- Create: `src/content/meet-caption-observer.js`
- Create: `src/content/meet-banner.js`
- Create: `src/content/meet-detector.js` (entry point)

- [ ] **Step 1: Write `meet-selectors.js`**

```js
// src/content/meet-selectors.js
// Selectores best-effort — Meet no expone una API estable para esto. Confirmar contra
// el DOM real en la verificación manual (Task 11) y ajustar acá si no matchean; es el
// único archivo que debería necesitar cambios cuando Meet actualice su interfaz.
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

- [ ] **Step 2: Write `meet-mute-observer.js`**

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

- [ ] **Step 3: Write `meet-caption-observer.js`**

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

- [ ] **Step 4: Write `meet-banner.js` (sin pausa: solo iniciar/detener/activar video)**

```js
// src/content/meet-banner.js
let bannerEl = null;
let statusEl = null;
let startButtonEl = null;
let videoButtonEl = null;
let stopButtonEl = null;

const STATE_LABELS = {
  idle: "Reunión detectada.",
  starting: "Iniciando grabación…",
  recording: "Grabando audio y transcripción.",
  "video-enabled": "Grabando audio, transcripción y video.",
  error: "No se pudo iniciar la grabación.",
};

export function showBanner({ onStart, onStop }) {
  if (bannerEl) return;

  bannerEl = document.createElement("div");
  bannerEl.id = "asterion-banner";
  Object.assign(bannerEl.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: "999999",
    background: "#202124",
    color: "#fff",
    padding: "12px 16px",
    borderRadius: "8px",
    fontFamily: "sans-serif",
    fontSize: "14px",
  });

  statusEl = document.createElement("span");
  bannerEl.appendChild(statusEl);

  startButtonEl = document.createElement("button");
  startButtonEl.textContent = "Iniciar grabación";
  startButtonEl.style.marginLeft = "8px";
  startButtonEl.addEventListener("click", onStart);
  bannerEl.appendChild(startButtonEl);

  // Este botón NO lleva su propio listener acá: el clic real lo captura el bootstrap
  // MAIN world (Task 6) directamente sobre el DOM, para no perder el gesto de usuario
  // que getDisplayMedia() necesita. Solo marcamos el atributo que ese bootstrap reconoce.
  videoButtonEl = document.createElement("button");
  videoButtonEl.textContent = "Activar video";
  videoButtonEl.style.marginLeft = "8px";
  videoButtonEl.setAttribute("data-asterion-enable-video", "");
  bannerEl.appendChild(videoButtonEl);

  stopButtonEl = document.createElement("button");
  stopButtonEl.textContent = "Detener";
  stopButtonEl.style.marginLeft = "8px";
  stopButtonEl.addEventListener("click", onStop);
  bannerEl.appendChild(stopButtonEl);

  document.body.appendChild(bannerEl);
  updateBannerState("idle");
}

export function updateBannerState(state, meta = {}) {
  if (!statusEl) return;
  statusEl.textContent = STATE_LABELS[state] ?? state;
  if (startButtonEl) startButtonEl.style.display = state === "idle" || state === "error" ? "inline-block" : "none";
  if (videoButtonEl) videoButtonEl.style.display = state === "recording" ? "inline-block" : "none";
  if (stopButtonEl)
    stopButtonEl.style.display = state === "recording" || state === "video-enabled" ? "inline-block" : "none";
  if (meta.videoError) console.warn("[Asterion] No se pudo activar video:", meta.videoError);
}
```

- [ ] **Step 5: Write `meet-detector.js` (entry point — detección, política de auto-inicio, puente de mensajes)**

```js
// src/content/meet-detector.js
import { SELECTORS } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { showBanner, updateBannerState } from "./meet-banner.js";

function isInActiveMeeting() {
  return document.querySelector(SELECTORS.hangUpButton) !== null;
}

function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function postToMainWorld(message) {
  window.postMessage({ source: "asterion-isolated-world", ...message }, "*");
}

let sessionId = null;

function startRecording() {
  if (sessionId) return;
  sessionId = generateSessionId();
  updateBannerState("starting");
  postToMainWorld({ type: "asterion:start-session", sessionId });

  observeMuteState((muted, timestampMs) => {
    postToMainWorld({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });

  enableCaptionsAndObserve((snapshot) => {
    chrome.runtime.sendMessage({ type: "asterion:caption-snapshot", sessionId, snapshot });
  });
}

function stopRecording() {
  if (!sessionId) return;
  postToMainWorld({ type: "asterion:stop-session", sessionId });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-main-world") return;

  if (message.type === "asterion:session-started") {
    updateBannerState("recording");
  } else if (message.type === "asterion:start-failed") {
    sessionId = null;
    updateBannerState("error");
    console.error("[Asterion] No se pudo iniciar la sesión:", message.reason);
  } else if (message.type === "asterion:chunk") {
    chrome.runtime.sendMessage({
      type: "asterion:chunk",
      sessionId: message.sessionId,
      stream: message.stream,
      seq: message.seq,
      buffer: message.buffer,
    });
  } else if (message.type === "asterion:video-enabled") {
    updateBannerState("video-enabled");
  } else if (message.type === "asterion:video-enable-failed") {
    updateBannerState("recording", { videoError: message.message });
  } else if (message.type === "asterion:session-ended") {
    chrome.runtime.sendMessage({
      type: "asterion:session-ended",
      sessionId: message.sessionId,
      muteManifest: message.muteManifest,
    });
    sessionId = null;
    updateBannerState("idle");
  }
});

// Si la pestaña se cierra o navega fuera con una sesión activa, avisarle al bootstrap
// MAIN world para que finalice y emita lo que alcanzó a grabar (PRD 5.8).
window.addEventListener("pagehide", () => {
  if (sessionId) postToMainWorld({ type: "asterion:stop-session", sessionId });
});

function waitForMeeting() {
  const observer = new MutationObserver(() => {
    if (isInActiveMeeting()) {
      observer.disconnect();
      chrome.storage.local.get({ autoStart: true }, ({ autoStart }) => {
        showBanner({ onStart: startRecording, onStop: stopRecording });
        if (autoStart) startRecording();
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

waitForMeeting();
```

- [ ] **Step 6: Manual verification**

Correr `npm run build:content` (agregar `src/content/meet-detector.js` como entrypoint si el script de build todavía apunta a otro archivo — confirmar contra `package.json` del Task 1), recargar la extensión, entrar a una reunión real de Meet.

Expected: aparece el banner "Reunión detectada." y, si `autoStart` no está seteado en `chrome.storage.local` (por defecto `true` según el PRD 5.10), arranca sola sin clic — cambia a "Grabando audio y transcripción." En la consola de la página, los mensajes `asterion:chunk` deberían empezar a llegar al *listener* del `chrome.runtime.onMessage` (todavía no hay nada escuchando del lado del service worker — eso es la Task 8, así que por ahora solo confirmar que se emiten sin error, por ejemplo con un `console.log` temporal en el arranque de `chrome.runtime.onMessage.addListener` de un service worker mínimo).

Advertencia conocida: los selectores de `meet-selectors.js` son best-effort y muy probablemente van a necesitar ajuste contra el DOM real — no es un fallo de esta tarea, es el riesgo ya documentado en el PRD (sección 8).

**Punto a validar cuando exista el receptor (Task 9):** confirmar que `chrome.runtime.sendMessage` efectivamente transporta el `ArrayBuffer` de cada chunk sin corromperlo — no todas las versiones de Chrome soportan tipos no-JSON en mensajería de extensión sin un opt-in explícito (ver hallazgo de Codex en la decisión del Task 4). Si llega vacío o corrupto del otro lado, la salida es convertir el `ArrayBuffer` a base64 antes de enviarlo (cambio acotado a `meet-detector.js` y al receptor).

- [ ] **Step 7: Commit**

```bash
git add src/content/
git commit -m "feat: add ISOLATED-world content script (detection, banner, bridge)"
```

---

## Task 8: Service worker — control plane

Sin `chrome.tabCapture` ni lógica de media: solo administra el ciclo de vida del offscreen document (Task 9) y el índice de historial. Se enteró de que una sesión arrancó por el mensaje `asterion:session-starting` que el content script (Task 7, ya corregido) manda en paralelo a `postToMainWorld`, no después.

**Files:**
- Create: `src/background/service-worker.js`

- [ ] **Step 1: Write `service-worker.js`**

```js
// src/background/service-worker.js
const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const activeSessionTabIds = new Map();
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
        reasons: ["BLOBS"],
        justification: "Escribir localmente el audio, video y transcripción de una reunión de Meet.",
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }
  await offscreenCreationPromise;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "asterion:session-starting") {
    activeSessionTabIds.set(message.sessionId, sender.tab?.id ?? null);
    ensureOffscreenDocument();
  } else if (message.type === "asterion:session-finalized") {
    activeSessionTabIds.delete(message.sessionId);
    appendToHistory(message);
    if (activeSessionTabIds.size === 0) {
      chrome.offscreen.closeDocument().catch(() => {});
    }
  }
});

function appendToHistory(meta) {
  chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
    meetingHistory.unshift({
      sessionId: meta.sessionId,
      folderName: meta.folderName,
      startedAt: meta.startedAt,
      hasTranscript: meta.hasTranscript,
      hasVideo: meta.hasVideo,
    });
    chrome.storage.local.set({ meetingHistory: meetingHistory.slice(0, 200) });
  });
}
```

Nota: `asterion:chunk` y `asterion:caption-snapshot` NO se relayan acá — el content script los manda con `chrome.runtime.sendMessage`, que ya llega a **todos** los contextos de la extensión escuchando (incluido el offscreen document de la Task 9) sin que el service worker tenga que reenviarlos. El service worker solo necesita saber cuándo empieza/termina una sesión para administrar el ciclo de vida del offscreen document.

- [ ] **Step 2: Commit**

```bash
git add src/background/
git commit -m "feat: add service worker control plane (offscreen lifecycle, history index)"
```

---

## Task 9: Offscreen document — sumidero de storage

Implementa la decisión del Task 4: sin `MediaRecorder`, solo recibe chunks ya grabados y los escribe con el `FileSystemDirectoryHandle` persistido (mismo origen de extensión que el popup).

**Files:**
- Create: `src/storage/directory-handle-store.js`
- Create: `src/storage/session-writer.js`
- Create: `src/offscreen/offscreen.html`
- Create: `src/offscreen/offscreen.js`

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

- [ ] **Step 2: Write `session-writer.js`**

```js
// src/storage/session-writer.js
import { loadRootDirectoryHandle } from "./directory-handle-store.js";
import { CaptionParser } from "../lib/caption-parser.js";

const STREAM_FILE_NAMES = {
  meeting: "audio-reunion.webm",
  mic: "audio-propio.webm",
  video: "video-reunion.webm",
};

function meetingFolderName(startedAt) {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `reunion-${iso}`;
}

export class SessionWriter {
  constructor({ sessionId, tabId }) {
    this.sessionId = sessionId;
    this.tabId = tabId;
    this.startedAt = Date.now();
    this.writablesByStream = new Map();
    this.captionParser = new CaptionParser();
    this.hasCaption = false;
    this.streamsUsed = new Set();
    this.ready = this._init();
  }

  async _init() {
    const rootHandle = await loadRootDirectoryHandle();
    if (!rootHandle) {
      throw new Error("No hay carpeta raíz configurada. Abrí el popup de Asterion y elegila.");
    }
    const permission = await rootHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      throw new Error("El permiso de la carpeta raíz ya no está activo. Volvé a elegirla desde el popup.");
    }
    this.meetingHandle = await rootHandle.getDirectoryHandle(meetingFolderName(this.startedAt), {
      create: true,
    });
  }

  async _getWritable(streamLabel) {
    await this.ready;
    if (this.writablesByStream.has(streamLabel)) {
      return this.writablesByStream.get(streamLabel);
    }
    const fileName = STREAM_FILE_NAMES[streamLabel];
    const fileHandle = await this.meetingHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    this.writablesByStream.set(streamLabel, writable);
    this.streamsUsed.add(streamLabel);
    return writable;
  }

  async writeChunk(streamLabel, buffer) {
    const writable = await this._getWritable(streamLabel);
    await writable.write(buffer);
  }

  onCaptionSnapshot(snapshot) {
    this.hasCaption = true;
    this.captionParser.onSnapshot(snapshot);
  }

  async finalize({ muteManifest }) {
    await this.ready;
    this.captionParser.finalizeCurrent(Date.now());

    for (const writable of this.writablesByStream.values()) {
      await writable.close();
    }

    if (this.hasCaption) {
      const transcriptText = this.captionParser.finishedSegments
        .map((segment) => `[${segment.speaker}] ${segment.text}`)
        .join("\n");
      const fileHandle = await this.meetingHandle.getFileHandle("transcripcion.txt", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(transcriptText);
      await writable.close();
    }

    const manifestHandle = await this.meetingHandle.getFileHandle("manifest.json", { create: true });
    const manifestWritable = await manifestHandle.createWritable();
    await manifestWritable.write(
      JSON.stringify(
        {
          startedAt: this.startedAt,
          hasTranscript: this.hasCaption,
          hasVideo: this.streamsUsed.has("video"),
          muteManifest,
        },
        null,
        2
      )
    );
    await manifestWritable.close();

    return {
      sessionId: this.sessionId,
      tabId: this.tabId,
      folderName: this.meetingHandle.name,
      startedAt: this.startedAt,
      hasTranscript: this.hasCaption,
      hasVideo: this.streamsUsed.has("video"),
    };
  }
}
```

- [ ] **Step 3: Write `offscreen.html`**

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

- [ ] **Step 4: Write `offscreen.js`**

```js
// src/offscreen/offscreen.js
import { SessionWriter } from "../storage/session-writer.js";

const sessions = new Map();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "asterion:session-starting") {
    const writer = new SessionWriter({ sessionId: message.sessionId, tabId: sender.tab?.id ?? null });
    sessions.set(message.sessionId, writer);
    writer.ready.catch((error) => {
      console.error("[Asterion] No se pudo iniciar el storage de la sesión:", error);
    });
  } else if (message.type === "asterion:chunk") {
    const writer = sessions.get(message.sessionId);
    writer?.writeChunk(message.stream, message.buffer).catch((error) => {
      console.error("[Asterion] Error escribiendo chunk:", error);
    });
  } else if (message.type === "asterion:caption-snapshot") {
    sessions.get(message.sessionId)?.onCaptionSnapshot(message.snapshot);
  } else if (message.type === "asterion:session-ended") {
    const writer = sessions.get(message.sessionId);
    if (!writer) return;
    writer
      .finalize({ muteManifest: message.muteManifest })
      .then((meta) => {
        chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...meta });
      })
      .catch((error) => {
        console.error("[Asterion] Error finalizando la sesión:", error);
      })
      .finally(() => {
        sessions.delete(message.sessionId);
      });
  }
});
```

- [ ] **Step 5: Manual verification (requiere Task 10 — popup — para elegir la carpeta raíz; hacer un stub mínimo si Task 10 no está lista todavía: correr `saveRootDirectoryHandle` a mano desde la consola de una página de extensión)**

Con una carpeta raíz ya elegida, entrar a una reunión real de Meet, dejar que la sesión arranque sola (auto-inicio) y hablar/escuchar unos segundos, luego detener desde el banner.

Expected: aparece una subcarpeta `reunion-<timestamp>` con `audio-reunion.webm` y `audio-propio.webm` (y `video-reunion.webm` si se activó video), `manifest.json` con `muteManifest` e intervalos reales, y `transcripcion.txt` si hubo subtítulos disponibles (si no, el archivo simplemente no existe — PRD 5.1). Confirmar en la consola del offscreen document (`chrome://extensions` → inspeccionar vistas → `offscreen.html`) que no hay errores de escritura.

**Punto pendiente de Task 7 a re-confirmar acá:** si los `ArrayBuffer` de los chunks llegan corruptos o vacíos a `writeChunk`, es el riesgo de serialización de `chrome.runtime.sendMessage` ya anotado — la salida es codificar a base64 en el content script y decodificar acá.

## Bugs encontrados en verificación real con Meet (post-Task 12), ya corregidos

- **Selectores en inglés, no español** (commit `e79c9ee`): la UI real de Meet del usuario está en inglés. Se corrigieron `hangUpButton`, `micButton` y `captionsToggleButton` contra un diagnóstico real del DOM. `captionsContainer` se tomó del código fuente de Fireflies (`div[jsname="xySENc"][aria-live="polite"]`, alta confianza); `captionSpeakerName`/`captionText` siguen siendo best-effort sin confirmar (Fireflies no los necesita — lee el canal de datos WebRTC `captions_v2` de Meet directamente en vez de escrapear el DOM, algo a evaluar como mejora futura dado que ya tenemos la arquitectura de interceptación de WebRTC para el audio).
- **Los subtítulos no se activaban en auto-inicio** (commit `41d0ef1`): el clic al botón de subtítulos en `enableCaptionsAndObserve` ocurría una sola vez, antes del bucle de reintentos — si el botón no existía todavía en el DOM en ese instante (típico en auto-inicio, que dispara muy temprano), el clic se perdía y nunca se reintentaba. Corregido: el clic ahora se reintenta en cada vuelta del bucle.
- **Nada se guardaba / historial vacío** (commit `41d0ef1`): condición de carrera real, no un caso raro — el offscreen document se crea recién al llegar el primer `asterion:session-starting`, pero ese mensaje es un *broadcast*; si el offscreen document todavía no terminó de registrar su listener, nunca lo recibe, y ninguno de los mensajes siguientes (chunks, fin de sesión) encuentra una sesión de escritura activa. Corregido: el service worker ahora reenvía `session-starting` explícitamente después de confirmar que el offscreen document ya existe, y el offscreen document es idempotente ante recibir ese mensaje dos veces.

- [ ] **Step 6: Commit**

```bash
git add src/storage/ src/offscreen/
git commit -m "feat: add offscreen storage sink writing session chunks locally"
```

---

## Task 10: Popup — estado, transcripción en vivo, control, configuración ✅ (commit `1e2a6c4`)

**Limitación conocida (por diseño, no un bug):** el popup **no** ofrece un botón de "activar video" funcional. Ese gesto solo cuenta como activación de usuario válida para `getDisplayMedia()` si es un clic real sobre el documento de la pestaña de Meet (decisión del Task 6) — un clic en el popup (una ventana de extensión separada) no sirve. El popup sí puede iniciar/detener la grabación (eso no necesita gesto especial, ver Task 7), y muestra un texto indicando que el video se activa desde el aviso en la página.

**Limitación conocida de la transcripción en vivo:** el popup arma su propia transcripción a partir de los mismos mensajes `asterion:caption-snapshot` que ya se emiten (broadcast a toda la extensión), pero solo mientras está abierto — si se abre a mitad de la reunión, no tiene el texto anterior (no hay backlog). Aceptable para v1 según el PRD ("mejor esfuerzo").

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
    <style>
      body { font-family: sans-serif; width: 320px; padding: 12px; }
      h1 { font-size: 14px; margin: 0 0 8px; }
      section { margin-bottom: 12px; }
      #transcript {
        white-space: pre-wrap;
        max-height: 160px;
        overflow-y: auto;
        background: #f2f2f2;
        padding: 8px;
        font-size: 12px;
      }
      button { margin-top: 4px; }
    </style>
  </head>
  <body>
    <h1>Asterion</h1>

    <section>
      <div id="meeting-status">Consultando estado…</div>
      <button id="start-recording">Iniciar grabación</button>
      <button id="stop-recording">Detener</button>
      <p><small>El video se activa desde el aviso dentro de la página de Meet, no desde acá.</small></p>
    </section>

    <section>
      <strong>Transcripción en vivo (mejor esfuerzo, solo desde que se abrió el popup)</strong>
      <div id="transcript"></div>
    </section>

    <section>
      <label><input type="checkbox" id="auto-start" /> Iniciar grabación automáticamente</label>
    </section>

    <section>
      <button id="choose-folder">Elegir carpeta de grabaciones</button>
      <p id="folder-status"></p>
    </section>

    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `popup.js`**

```js
// src/popup/popup.js
import { saveRootDirectoryHandle, loadRootDirectoryHandle } from "../storage/directory-handle-store.js";
import { CaptionParser } from "../lib/caption-parser.js";

const folderButtonEl = document.getElementById("choose-folder");
const folderStatusEl = document.getElementById("folder-status");
const autoStartCheckboxEl = document.getElementById("auto-start");
const meetingStatusEl = document.getElementById("meeting-status");
const startButtonEl = document.getElementById("start-recording");
const stopButtonEl = document.getElementById("stop-recording");
const transcriptEl = document.getElementById("transcript");

const captionParser = new CaptionParser();
let activeTabId = null;

async function refreshFolderStatus() {
  const handle = await loadRootDirectoryHandle();
  folderStatusEl.textContent = handle ? `Carpeta actual: ${handle.name}` : "Ninguna carpeta elegida todavía.";
}

folderButtonEl.addEventListener("click", async () => {
  const handle = await window.showDirectoryPicker();
  await handle.requestPermission({ mode: "readwrite" });
  await saveRootDirectoryHandle(handle);
  await refreshFolderStatus();
});

chrome.storage.local.get({ autoStart: true }, ({ autoStart }) => {
  autoStartCheckboxEl.checked = autoStart;
});
autoStartCheckboxEl.addEventListener("change", () => {
  chrome.storage.local.set({ autoStart: autoStartCheckboxEl.checked });
});

const STATUS_LABELS = {
  idle: "Sin grabar.",
  starting: "Iniciando…",
  recording: "Grabando.",
  "video-enabled": "Grabando con video.",
  error: "Error al iniciar.",
};

function renderMeetingStatus(status) {
  if (!status || !status.inMeeting) {
    meetingStatusEl.textContent = "No hay una reunión de Meet activa en esta pestaña.";
    startButtonEl.style.display = "none";
    stopButtonEl.style.display = "none";
    return;
  }
  meetingStatusEl.textContent = STATUS_LABELS[status.state] ?? status.state;
  startButtonEl.style.display = status.state === "idle" || status.state === "error" ? "inline-block" : "none";
  stopButtonEl.style.display =
    status.state === "recording" || status.state === "video-enabled" ? "inline-block" : "none";
}

async function refreshMeetingStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.startsWith("https://meet.google.com/")) {
    activeTabId = null;
    renderMeetingStatus(null);
    return;
  }
  activeTabId = tab.id;
  chrome.tabs.sendMessage(tab.id, { type: "asterion:get-status" }, (response) => {
    if (chrome.runtime.lastError) {
      renderMeetingStatus(null);
      return;
    }
    renderMeetingStatus(response);
  });
}

startButtonEl.addEventListener("click", () => {
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: "asterion:popup-start" });
});
stopButtonEl.addEventListener("click", () => {
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: "asterion:popup-stop" });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:caption-snapshot") {
    captionParser.onSnapshot(message.snapshot);
    renderTranscript();
  }
});

function renderTranscript() {
  const lines = captionParser.finishedSegments.map((s) => `[${s.speaker}] ${s.text}`);
  if (captionParser.current) lines.push(`[${captionParser.current.speaker}] ${captionParser.current.text}`);
  transcriptEl.textContent = lines.join("\n") || "(sin transcripción todavía)";
}

refreshFolderStatus();
refreshMeetingStatus();
setInterval(refreshMeetingStatus, 2000);
```

- [ ] **Step 3: Manual verification**

Cargar la extensión, entrar a una reunión real de Meet, abrir el popup.
Expected: "Elegir carpeta de grabaciones" persiste entre aperturas del popup; el checkbox de auto-inicio refleja y guarda su estado; con la reunión detectada, el estado y los botones Iniciar/Detener reflejan correctamente lo que está pasando en la pestaña (probar tapando ambos casos: auto-inicio activado y desactivado); si hay subtítulos fluyendo, el texto de transcripción se actualiza mientras el popup permanece abierto.

- [ ] **Step 4: Commit**

```bash
git add src/popup/
git commit -m "feat: add popup with status, live transcript, controls, and settings"
```

---

## Task 11: Historial mínimo + verificación end-to-end ✅ (código commiteado en `a30d7dc`; verificación manual — Step 4 — a cargo del usuario, ver Task 12)

**Files:**
- Create: `src/history/history.html`
- Create: `src/history/history.js`
- Modify: `manifest.json` (agregar acceso al historial, por ejemplo un link desde el popup o una `chrome_url_overrides`/página independiente abierta con `chrome.tabs.create`)

- [ ] **Step 1: Write `history.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Asterion — Historial</title>
    <style>
      body { font-family: sans-serif; padding: 16px; max-width: 640px; }
      li { margin-bottom: 12px; }
      button { margin-left: 8px; }
    </style>
  </head>
  <body>
    <h1>Historial de reuniones</h1>
    <ul id="history-list"></ul>
    <script type="module" src="history.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `history.js`**

```js
// src/history/history.js
import { loadRootDirectoryHandle } from "../storage/directory-handle-store.js";

const listEl = document.getElementById("history-list");

async function openMeetingFolder(folderName) {
  const rootHandle = await loadRootDirectoryHandle();
  if (!rootHandle) return;
  const meetingHandle = await rootHandle.getDirectoryHandle(folderName);
  for await (const [name, handle] of meetingHandle.entries()) {
    if (handle.kind !== "file") continue;
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, "_blank");
  }
}

chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
  if (meetingHistory.length === 0) {
    listEl.innerHTML = "<li>Todavía no hay reuniones grabadas.</li>";
    return;
  }

  for (const meeting of meetingHistory) {
    const li = document.createElement("li");
    const date = new Date(meeting.startedAt).toLocaleString();
    const flags = [meeting.hasTranscript ? "transcripción" : null, meeting.hasVideo ? "video" : null]
      .filter(Boolean)
      .join(", ");
    li.textContent = `${date} — ${meeting.folderName}${flags ? ` (${flags})` : ""}`;

    const openButton = document.createElement("button");
    openButton.textContent = "Abrir archivos";
    openButton.addEventListener("click", () => openMeetingFolder(meeting.folderName));
    li.appendChild(openButton);

    listEl.appendChild(li);
  }
});
```

Nota: "Abrir archivos" abre cada archivo de esa reunión en una pestaña nueva vía blob URL (no hay una API de extensiones para "mostrar en el Finder/Explorador" directamente sobre un `FileSystemDirectoryHandle`) — suficiente para cumplir PRD 5.7 ("acceder directamente a los archivos de una reunión específica"). Si en el futuro se quiere abrir el Finder/Explorador directamente, es una mejora de UX, no un requerimiento de esta fase.

- [ ] **Step 3: Wire access to history from the popup**

Agregar en `popup.html` (dentro de la última `<section>`, junto al botón de carpeta):

```html
<button id="open-history">Ver historial</button>
```

Y en `popup.js`:

```js
document.getElementById("open-history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/history/history.html") });
});
```

- [ ] **Step 4: Manual verification**

Con al menos una reunión ya grabada (de las verificaciones manuales de Tasks 9-10), abrir el popup → "Ver historial".
Expected: aparece la reunión con fecha y nombre de carpeta, con las etiquetas `transcripción`/`video` según corresponda; "Abrir archivos" abre cada archivo capturado en una pestaña nueva.

- [ ] **Step 5: Commit**

```bash
git add src/history/ src/popup/popup.html src/popup/popup.js
git commit -m "feat: add minimal meeting history view"
```

---

## Task 12: Verificación end-to-end con una reunión real (a cargo del usuario)

Esto no se puede automatizar ni delegar — requiere una cuenta de Google y una reunión real de Meet. Checklist basado en los riesgos que el PRD deja explícitos como pendientes de validar (sección 8):

- [ ] Cargar la extensión sin empaquetar (`chrome://extensions` → Cargar descomprimida) y correr `npm run build` antes.
- [ ] Elegir carpeta de grabaciones desde el popup.
- [ ] Entrar a una reunión real (puede ser en solitario, con un segundo dispositivo/pestaña actuando de "otro participante" para generar audio remoto).
- [ ] Confirmar auto-inicio: la grabación arranca sola al detectar la reunión, sin clic.
- [ ] Confirmar `window.__asterionDiagnostics` en la consola de la pestaña de Meet: `peerConnectionsCreated`, `remoteAudioTracksSeen`, `micTracksSeen` todos mayores a 0.
- [ ] Mutear y desmutear el propio mic un par de veces; al finalizar, confirmar que `audio-propio.webm` refleja solo los tramos desmuteados (duración aproximada) y que `manifest.json` tiene los intervalos correctos.
- [ ] Activar video desde el botón del banner (no desde el popup); confirmar que aparece el diálogo nativo de "Allow" de Chrome y que, al aceptar, se genera `video-reunion.webm`.
- [ ] Confirmar que `audio-reunion.webm` contiene el audio del otro participante.
- [ ] Si Meet tenía subtítulos disponibles, confirmar `transcripcion.txt`; si no, confirmar que la reunión se grabó igual sin ese archivo (PRD 5.1).
- [ ] Cerrar la pestaña de Meet a mitad de una grabación (sin usar el botón "Detener") y confirmar que los archivos igual se generaron con lo capturado hasta ese momento.
- [ ] Selectores de `meet-selectors.js`: si algo no funcionó (banner no aparece, mute no se detecta, subtítulos no se activan), inspeccionar el DOM real de Meet con DevTools y ajustar ese archivo — es el único lugar que debería necesitar cambios.
- [ ] Validar el punto pendiente de las Tasks 7/9: si los chunks de audio llegan corruptos o vacíos al offscreen document, cambiar la codificación de `ArrayBuffer` a base64 en el content script y decodificarla en `session-writer.js`.
