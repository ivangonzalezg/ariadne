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

---

## Task 13: Audio combinado en un solo archivo + selectores de subtítulos robustos (`jsname`)

Cambio de diseño decidido por el usuario tras confirmar cómo lo hace Fireflies (ver PRD, secciones 4.1/5.2/5.3/6 ya actualizadas) y validado con Codex. Reemplaza los dos `MediaRecorder` separados de audio (reunión + propio) por uno solo, mezclado en tiempo real con Web Audio API; el mic se gatea con un `GainNode` (no pausando el `MediaRecorder`, que también cortaría el audio remoto). De paso corrige tres bugs reales que Codex encontró al revisar el diseño: tipo MIME incorrecto para el video, observers de mute/captions que no se limpiaban entre sesiones, y una condición de carrera donde el último chunk de audio podía no llegar a tiempo antes de finalizar la sesión.

**Files:**
- Modify: `src/webrtc-bootstrap/audio-mixer.js` (renombrar `RemoteAudioMixer` → `MeetingAudioMixer`, agregar mic + `GainNode`)
- Modify: `src/webrtc-bootstrap/session.js` (un solo recorder de audio, esperar los últimos chunks antes de finalizar, MIME correcto para video)
- Modify: `src/webrtc-bootstrap/bootstrap.js` (usar `MeetingAudioMixer`, pasar `initialMicMuted`)
- Modify: `src/content/meet-detector.js` (conocer el estado inicial de mute antes de arrancar la sesión, limpiar observers al terminar)
- Modify: `src/content/meet-caption-observer.js` (activar subtítulos una sola vez — no reintentar el clic — y ocultarlos con CSS en vez de desactivarlos)
- Modify: `src/content/meet-selectors.js` (`captionsToggleButton` por `jsname`, más robusto que `aria-label`)
- Modify: `src/storage/session-writer.js` (quitar el mapeo de archivo `"mic"`)

- [ ] **Step 1: Rewrite `audio-mixer.js`**

```js
// src/webrtc-bootstrap/audio-mixer.js
export class MeetingAudioMixer {
  constructor() {
    this.audioContext = new AudioContext();
    this.destination = this.audioContext.createMediaStreamDestination();
    this.remoteSourceNodesByTrackId = new Map();
    this.micSourceNode = null;
    this.micGainNode = null;
  }

  addRemoteTrack(track) {
    if (this.remoteSourceNodesByTrackId.has(track.id)) return;
    const trackStream = new MediaStream([track]);
    const sourceNode = this.audioContext.createMediaStreamSource(trackStream);
    sourceNode.connect(this.destination);
    this.remoteSourceNodesByTrackId.set(track.id, sourceNode);
    track.addEventListener("ended", () => this.removeRemoteTrack(track.id));
  }

  removeRemoteTrack(trackId) {
    const sourceNode = this.remoteSourceNodesByTrackId.get(trackId);
    if (!sourceNode) return;
    sourceNode.disconnect();
    this.remoteSourceNodesByTrackId.delete(trackId);
  }

  setMicTrack(micTrack, { initiallyMuted }) {
    const micStream = new MediaStream([micTrack]);
    this.micSourceNode = this.audioContext.createMediaStreamSource(micStream);
    this.micGainNode = this.audioContext.createGain();
    this.micGainNode.gain.value = initiallyMuted ? 0 : 1;
    this.micSourceNode.connect(this.micGainNode);
    this.micGainNode.connect(this.destination);
  }

  setMicMuted(muted) {
    if (!this.micGainNode) return;
    const now = this.audioContext.currentTime;
    const targetGain = muted ? 0 : 1;
    // Rampa corta en vez de asignar gain.value directo — evita un "click" audible
    // en la transición.
    this.micGainNode.gain.cancelScheduledValues(now);
    this.micGainNode.gain.setValueAtTime(this.micGainNode.gain.value, now);
    this.micGainNode.gain.linearRampToValueAtTime(targetGain, now + 0.01);
  }

  get stream() {
    return this.destination.stream;
  }

  async close() {
    await this.audioContext.close();
  }
}
```

- [ ] **Step 2: Rewrite `session.js`**

```js
// src/webrtc-bootstrap/session.js
import { MuteManifest } from "../lib/mute-manifest.js";

const CHUNK_TIMESLICE_MS = 1000;

export class MainWorldSession {
  constructor({ sessionId, mixer, postToIsolated, initialMicMuted }) {
    this.sessionId = sessionId;
    this.mixer = mixer;
    this.postToIsolated = postToIsolated;
    this.muteManifest = new MuteManifest({ startedAt: Date.now() });
    this.seq = { meeting: 0, video: 0 };
    this.videoRecorder = null;
    this.videoStream = null;
    this._meetingWrites = null;
    this._videoWrites = null;

    if (!initialMicMuted) {
      this.muteManifest.onUnmuted(Date.now());
    }
  }

  start() {
    const { recorder, waitForPendingWrites } = this._startRecorder(this.mixer.stream, "meeting", "audio/webm");
    this.meetingRecorder = recorder;
    this._meetingWrites = waitForPendingWrites;
  }

  _startRecorder(stream, streamLabel, mimeType) {
    const recorder = new MediaRecorder(stream, { mimeType });
    // Cadena secuencial: cada chunk espera a que el anterior termine de procesarse
    // y mandarse antes de seguir — evita que lleguen desordenados, y stop() puede
    // esperar a que esta cadena termine para saber que el último chunk ya salió.
    let writeChain = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.seq[streamLabel] += 1;
      const seq = this.seq[streamLabel];
      writeChain = writeChain.then(async () => {
        const buffer = await event.data.arrayBuffer();
        this.postToIsolated(
          { type: "asterion:chunk", sessionId: this.sessionId, stream: streamLabel, seq, buffer },
          [buffer]
        );
      });
    };
    recorder.start(CHUNK_TIMESLICE_MS);
    return { recorder, waitForPendingWrites: () => writeChain };
  }

  onMicMuted(timestampMs) {
    this.muteManifest.onMuted(timestampMs);
    this.mixer.setMicMuted(true);
  }

  onMicUnmuted(timestampMs) {
    this.muteManifest.onUnmuted(timestampMs);
    this.mixer.setMicMuted(false);
  }

  enableVideo(displayStream) {
    if (this.videoRecorder) return;
    this.videoStream = displayStream;
    // Bug corregido: antes se forzaba "audio/webm" también para el stream de video.
    const { recorder, waitForPendingWrites } = this._startRecorder(displayStream, "video", "video/webm");
    this.videoRecorder = recorder;
    this._videoWrites = waitForPendingWrites;
  }

  async stop() {
    this.muteManifest.finalize(Date.now());
    const recorders = [this.meetingRecorder, this.videoRecorder].filter(Boolean);

    const stopped = recorders.map(
      (r) =>
        new Promise((resolve) => {
          r.onstop = resolve;
        })
    );
    recorders.forEach((r) => r.stop());
    await Promise.all(stopped);

    // Esperar a que el último chunk (el que dispara el evento "stop") termine de
    // procesarse y enviarse — si no, se podía señalar el fin de sesión antes de
    // que ese último pedazo de audio/video llegara al offscreen document.
    await Promise.all([this._meetingWrites?.(), this._videoWrites?.()].filter(Boolean));

    this.videoStream?.getTracks().forEach((t) => t.stop());

    this.postToIsolated({
      type: "asterion:session-ended",
      sessionId: this.sessionId,
      muteManifest: this.muteManifest.toJSON(),
    });
  }
}
```

- [ ] **Step 3: Rewrite `bootstrap.js`**

```js
// src/webrtc-bootstrap/bootstrap.js
import { installRtcPatch, installGetUserMediaPatch, diagnostics } from "./rtc-patch.js";
import { MeetingAudioMixer } from "./audio-mixer.js";
import { MainWorldSession } from "./session.js";

const mixer = new MeetingAudioMixer();
let micTrack = null;
let session = null;

installRtcPatch({
  onRemoteAudioTrack: (track) => mixer.addRemoteTrack(track),
  onConnectionClosed: () => {},
});

installGetUserMediaPatch({
  onMicStream: (stream, audioTrack) => {
    micTrack = audioTrack;
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
    if (!micTrack) {
      postToIsolated({ type: "asterion:start-failed", sessionId: message.sessionId, reason: "no-mic-stream" });
      return;
    }
    mixer.setMicTrack(micTrack, { initiallyMuted: Boolean(message.initialMicMuted) });
    session = new MainWorldSession({
      sessionId: message.sessionId,
      mixer,
      postToIsolated,
      initialMicMuted: Boolean(message.initialMicMuted),
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

- [ ] **Step 4: Modify `meet-detector.js`** — conocer el estado inicial de mute antes de avisarle a `MAIN world` que arranque, y limpiar los observers de mute/captions al terminar la sesión (antes se descartaban sus funciones de limpieza, dejando observers vivos entre reuniones)

```js
// src/content/meet-detector.js
import { SELECTORS } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { showBanner, updateBannerState } from "./meet-banner.js";
import { arrayBufferToBase64 } from "../lib/base64.js";

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
let currentState = "idle";
let stopMuteObserver = () => {};
let stopCaptionObserver = () => {};

function setState(state) {
  currentState = state;
  updateBannerState(state);
}

function cleanupObservers() {
  stopMuteObserver();
  stopCaptionObserver();
  stopMuteObserver = () => {};
  stopCaptionObserver = () => {};
}

async function startRecording() {
  if (sessionId) return;
  sessionId = generateSessionId();
  setState("starting");

  chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId });

  let isFirstMuteReport = true;

  // observeMuteState informa el estado actual de forma síncrona en su primera
  // llamada — se aprovecha eso para mandar "start-session" recién ahí, con el
  // estado real de mute ya conocido (el GainNode del mic necesita arrancar en
  // el valor correcto desde el primer instante, ver Task 13 del plan).
  stopMuteObserver = observeMuteState((muted, timestampMs) => {
    if (isFirstMuteReport) {
      isFirstMuteReport = false;
      postToMainWorld({ type: "asterion:start-session", sessionId, initialMicMuted: muted });
      return;
    }
    postToMainWorld({
      type: muted ? "asterion:mic-muted" : "asterion:mic-unmuted",
      timestampMs,
    });
  });

  const cleanup = await enableCaptionsAndObserve((snapshot) => {
    chrome.runtime.sendMessage({ type: "asterion:caption-snapshot", sessionId, snapshot });
  });
  stopCaptionObserver = cleanup ?? (() => {});
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
    setState("recording");
  } else if (message.type === "asterion:start-failed") {
    sessionId = null;
    setState("error");
    cleanupObservers();
    console.error("[Asterion] No se pudo iniciar la sesión:", message.reason);
  } else if (message.type === "asterion:chunk") {
    chrome.runtime.sendMessage({
      type: "asterion:chunk",
      sessionId: message.sessionId,
      stream: message.stream,
      seq: message.seq,
      bufferBase64: arrayBufferToBase64(message.buffer),
    });
  } else if (message.type === "asterion:video-enabled") {
    setState("video-enabled");
  } else if (message.type === "asterion:video-enable-failed") {
    updateBannerState(currentState, { videoError: message.message });
  } else if (message.type === "asterion:session-ended") {
    chrome.runtime.sendMessage({
      type: "asterion:session-ended",
      sessionId: message.sessionId,
      muteManifest: message.muteManifest,
    });
    sessionId = null;
    setState("idle");
    cleanupObservers();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "asterion:get-status") {
    sendResponse({ inMeeting: isInActiveMeeting(), state: currentState });
    return true;
  }
  if (message.type === "asterion:popup-start") {
    startRecording();
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "asterion:popup-stop") {
    stopRecording();
    sendResponse({ ok: true });
    return true;
  }
});

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

- [ ] **Step 5: Rewrite `meet-caption-observer.js`** — activar subtítulos una sola vez (reintentando solo hasta encontrar el botón, no re-clicándolo después de haber tenido éxito) y ocultarlos visualmente con CSS en vez de alternar el control nativo

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

function observeCaptions(onSnapshot) {
  const container = findCaptionsContainer();
  if (!container) return () => {};

  const observer = new MutationObserver(() => {
    const snapshot = readCurrentSnapshot(container);
    if (snapshot) onSnapshot(snapshot);
  });

  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

const HIDE_STYLE_ID = "asterion-hide-captions";

function hideCaptionsVisually() {
  if (document.getElementById(HIDE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIDE_STYLE_ID;
  // opacity + pointer-events en vez de display:none/visibility:hidden — Meet deja
  // de actualizar el DOM de subtítulos si el contenedor no es visible, lo que
  // rompería el MutationObserver.
  style.textContent = `${SELECTORS.captionsContainer} { opacity: 0 !important; pointer-events: none !important; }`;
  document.head.appendChild(style);
}

function clickCaptionsToggleOnceReady({ retries, delayMs }) {
  return new Promise((resolve) => {
    let attemptsLeft = retries;
    const tryClick = () => {
      const button = document.querySelector(SELECTORS.captionsToggleButton);
      if (button) {
        button.click();
        resolve(true);
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) {
        setTimeout(tryClick, delayMs);
      } else {
        resolve(false);
      }
    };
    tryClick();
  });
}

export async function enableCaptionsAndObserve(onSnapshot, { retries = 10, delayMs = 300 } = {}) {
  hideCaptionsVisually();

  if (findCaptionsContainer()) {
    return observeCaptions(onSnapshot);
  }

  // Clic una sola vez (reintentando solo hasta que el botón exista en el DOM,
  // no repitiendo el clic después de haber tenido éxito — antes esto podía volver
  // a apagar los subtítulos si el contenedor tardaba en aparecer).
  await clickCaptionsToggleOnceReady({ retries, delayMs });

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

- [ ] **Step 6: Modify `meet-selectors.js`** — `captionsToggleButton` por el atributo `jsname` real de Meet (de Fireflies), no por `aria-label`

```js
// src/content/meet-selectors.js
export const SELECTORS = {
  hangUpButton: '[aria-label="Leave call"]',
  micButton: '[aria-label*="microphone" i]',
  micMutedAttribute: "data-is-muted",
  captionsToggleButton: 'button[jsname="RrG0hf"], button[jslog^="211197"]',
  captionsContainer: 'div[jsname="xySENc"][aria-live="polite"]',
  captionSpeakerName: ".NWpY1d",
  captionText: ".ygicle.VbkSUe",
};
```

- [ ] **Step 7: Modify `session-writer.js`** — quitar el mapeo de archivo `"mic"` (ya no existe ese stream)

```js
// src/storage/session-writer.js — cambiar solo esta constante, el resto del archivo no cambia
const STREAM_FILE_NAMES = {
  meeting: "audio-reunion.webm",
  video: "video-reunion.webm",
};
```

- [ ] **Step 8: Build + tests**

```bash
npm run build
npm test
```

Expected: `npm run build` compila los dos bundles sin error (confirma que las importaciones entre `audio-mixer.js`/`session.js`/`bootstrap.js` y entre `meet-detector.js`/`meet-caption-observer.js`/`meet-selectors.js` siguen resolviendo). `npm test` sigue en 13/13 — esta tarea no toca `src/lib/`.

- [ ] **Step 9: Manual verification**

Recargar la extensión, entrar a una reunión real de Meet, dejar que arranque sola.

Expected: solo aparece un archivo de audio (`audio-reunion.webm`, sin `audio-propio.webm`) que contiene tanto el audio de los demás participantes como la voz propia, con la voz propia ausente durante los tramos en que el mic estuvo silenciado (y el audio del otro participante sin cortes durante esos mismos tramos). Los subtítulos deben seguir apareciendo en la transcripción capturada aunque el panel visual de Meet ya no se vea en pantalla (oculto por CSS). Verificar además que detener y volver a grabar una segunda vez (sin recargar la pestaña) no deja observers duplicados (por ejemplo, que la transcripción de la segunda reunión no incluya texto de la primera).

- [ ] **Step 10: Commit**

```bash
git add src/webrtc-bootstrap/ src/content/meet-detector.js src/content/meet-caption-observer.js src/content/meet-selectors.js src/storage/session-writer.js
git commit -m "feat: mix meeting and mic audio into a single file, harden caption selectors and session cleanup"
```

---

## Task 14: Storage sin permisos — OPFS en vez de directorio externo, descarga bajo demanda desde el historial

Decisión con Codex (ver conversación de esta sesión): el permiso sobre el directorio elegido por el usuario (File System Access API) se vencía impredeciblemente en uso real, causando pérdida silenciosa de grabaciones justo en el caso más importante (auto-inicio sin interacción previa del usuario). Se reemplaza por el almacenamiento privado de la extensión (OPFS, `navigator.storage.getDirectory()`), que no pide ningún permiso. El historial pasa a ofrecer descarga explícita por archivo en vez de "abrir en pestaña nueva" desde una carpeta ya accesible.

**Files:**
- Modify: `manifest.json` (agregar `"unlimitedStorage"` y `"downloads"`)
- Modify: `src/storage/session-writer.js` (OPFS en vez de directorio externo, serializar escrituras por stream)
- Delete: `src/storage/directory-handle-store.js` (ya no lo usa nadie)
- Modify: `src/popup/popup.html` y `src/popup/popup.js` (quitar elegir/renovar carpeta)
- Modify: `src/history/history.html` y `src/history/history.js` (leer de OPFS, botón de descarga por archivo)

- [ ] **Step 1: Modify `manifest.json`** — cambiar solo el array `"permissions"`:

```json
  "permissions": ["storage", "offscreen", "scripting", "unlimitedStorage", "downloads"],
```

- [ ] **Step 2: Rewrite `session-writer.js`**

```js
// src/storage/session-writer.js
import { CaptionParser } from "../lib/caption-parser.js";

const STREAM_FILE_NAMES = {
  meeting: "audio-reunion.webm",
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
    this.writeQueueByStream = new Map();
    this.captionParser = new CaptionParser();
    this.hasCaption = false;
    this.streamsUsed = new Set();
    this.ready = this._init();
  }

  async _init() {
    const root = await navigator.storage.getDirectory();
    this.meetingHandle = await root.getDirectoryHandle(meetingFolderName(this.startedAt), {
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

  writeChunk(streamLabel, buffer) {
    // Encadenar por stream: una escritura no arranca antes de que termine la
    // anterior del mismo archivo, y finalize() espera a que esta cola se vacíe
    // antes de cerrar los streams (si no, se podía cortar el último chunk).
    const previous = this.writeQueueByStream.get(streamLabel) ?? Promise.resolve();
    const next = previous.then(async () => {
      const writable = await this._getWritable(streamLabel);
      await writable.write(buffer);
    });
    this.writeQueueByStream.set(streamLabel, next);
    return next;
  }

  onCaptionSnapshot(snapshot) {
    this.hasCaption = true;
    this.captionParser.onSnapshot(snapshot);
  }

  async finalize({ muteManifest }) {
    await this.ready;
    this.captionParser.finalizeCurrent(Date.now());

    await Promise.all(this.writeQueueByStream.values());

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

`src/offscreen/offscreen.js` no necesita cambios — su llamada `writer?.writeChunk(...).catch(...)` sigue funcionando igual, `writeChunk` sigue devolviendo una promesa.

- [ ] **Step 3: Delete `src/storage/directory-handle-store.js`** — ya no lo importa nada (ni `session-writer.js` ni, después del Step 4, `popup.js`).

- [ ] **Step 4: Modify `popup.html`** — quitar los botones de carpeta, dejar solo el de historial con una nota:

```html
<!-- reemplazar esta sección: -->
    <section>
      <button id="choose-folder">Elegir carpeta de grabaciones</button>
      <button id="reauthorize-folder" style="display: none;">Renovar permiso</button>
      <button id="open-history">Ver historial</button>
      <p id="folder-status"></p>
    </section>

<!-- por esta: -->
    <section>
      <button id="open-history">Ver historial</button>
      <p><small>Las grabaciones se guardan dentro de la extensión. Descargalas desde el historial cuando quieras.</small></p>
    </section>
```

- [ ] **Step 5: Modify `popup.js`** — quitar todo lo relacionado a la carpeta

```js
// src/popup/popup.js
import { CaptionParser } from "../lib/caption-parser.js";

const autoStartCheckboxEl = document.getElementById("auto-start");
const meetingStatusEl = document.getElementById("meeting-status");
const startButtonEl = document.getElementById("start-recording");
const stopButtonEl = document.getElementById("stop-recording");
const transcriptEl = document.getElementById("transcript");

const captionParser = new CaptionParser();
let activeTabId = null;

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

document.getElementById("open-history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/history/history.html") });
});

refreshMeetingStatus();
setInterval(refreshMeetingStatus, 2000);
```

- [ ] **Step 6: Rewrite `history.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Asterion — Historial</title>
    <style>
      body { font-family: sans-serif; padding: 16px; max-width: 640px; }
      li { margin-bottom: 16px; }
      .files { margin-top: 4px; }
      .files button { margin-right: 8px; margin-bottom: 4px; }
    </style>
  </head>
  <body>
    <h1>Historial de reuniones</h1>
    <ul id="history-list"></ul>
    <script type="module" src="history.js"></script>
  </body>
</html>
```

- [ ] **Step 7: Rewrite `history.js`** — lee de OPFS, ofrece descargar cada archivo con `chrome.downloads.download({..., saveAs: true})`, revocando el object URL recién cuando la descarga termina o se interrumpe (no apenas se dispara, para no cortar archivos grandes)

```js
// src/history/history.js
const listEl = document.getElementById("history-list");

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

async function renderMeetingFiles(li, folderName) {
  const filesEl = document.createElement("div");
  filesEl.className = "files";
  li.appendChild(filesEl);

  const root = await navigator.storage.getDirectory();
  const meetingHandle = await root.getDirectoryHandle(folderName);

  for await (const [name, handle] of meetingHandle.entries()) {
    if (handle.kind !== "file") continue;
    const button = document.createElement("button");
    button.textContent = `Descargar ${name}`;
    button.addEventListener("click", async () => {
      const file = await handle.getFile();
      downloadFile(file, `${folderName}/${name}`);
    });
    filesEl.appendChild(button);
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
    const label = document.createElement("div");
    label.textContent = `${date} — ${meeting.folderName}${flags ? ` (${flags})` : ""}`;
    li.appendChild(label);

    renderMeetingFiles(li, meeting.folderName);

    listEl.appendChild(li);
  }
});
```

- [ ] **Step 8: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, `npm test` sigue en 13/13 (esta tarea no toca `src/lib/`).

- [ ] **Step 9: Manual verification**

Recargar la extensión (importante: los permisos del manifest cambiaron, Chrome puede pedir confirmarlos de nuevo al recargar). Entrar a una reunión con auto-inicio, **sin abrir el popup antes** (para probar justamente el caso que fallaba), dejar que grabe unos segundos, detener. Abrir el historial y descargar cada archivo — confirmar que el diálogo nativo de Chrome para elegir dónde guardar aparece, y que los archivos descargados abren bien.

- [ ] **Step 10: Commit**

```bash
git add manifest.json src/storage/session-writer.js src/popup/popup.html src/popup/popup.js src/history/history.html src/history/history.js
git rm src/storage/directory-handle-store.js
git commit -m "feat: switch storage to OPFS (no permission prompts) with on-demand download from history"
```

---

## Task 15: Historial — ver archivos en pestaña nueva + eliminar reuniones

Pedido del usuario tras probar el historial real: además de descargar, poder **ver** cada archivo abriéndolo en una pestaña nueva, y poder **eliminar** una reunión completa (para limpiar pruebas basura), lo cual borra su carpeta de OPFS y su entrada del historial.

**Files:**
- Modify: `src/history/history.js`

- [ ] **Step 1: Rewrite `history.js`**

```js
// src/history/history.js
const listEl = document.getElementById("history-list");

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
  // No se revoca el object URL acá: la pestaña nueva necesita poder seguir
  // leyendo el archivo mientras el usuario lo mira/escucha/reproduce.
  const url = URL.createObjectURL(file);
  chrome.tabs.create({ url });
}

async function renderMeetingFiles(container, folderName) {
  const root = await navigator.storage.getDirectory();
  const meetingHandle = await root.getDirectoryHandle(folderName);

  for await (const [name, handle] of meetingHandle.entries()) {
    if (handle.kind !== "file") continue;
    const file = await handle.getFile();

    const viewButton = document.createElement("button");
    viewButton.textContent = `Ver ${name}`;
    viewButton.addEventListener("click", () => viewFile(file));
    container.appendChild(viewButton);

    const downloadButton = document.createElement("button");
    downloadButton.textContent = `Descargar ${name}`;
    downloadButton.addEventListener("click", () => downloadFile(file, `${folderName}/${name}`));
    container.appendChild(downloadButton);
  }
}

async function deleteMeeting(folderName) {
  if (!confirm(`¿Eliminar la reunión "${folderName}"? Esto borra sus archivos y no se puede deshacer.`)) {
    return;
  }

  const root = await navigator.storage.getDirectory();
  await root.removeEntry(folderName, { recursive: true }).catch(() => {});

  chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
    const updated = meetingHistory.filter((meeting) => meeting.folderName !== folderName);
    chrome.storage.local.set({ meetingHistory: updated }, () => {
      render(updated);
    });
  });
}

function render(meetingHistory) {
  listEl.innerHTML = "";

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

    const label = document.createElement("div");
    label.textContent = `${date} — ${meeting.folderName}${flags ? ` (${flags})` : ""}`;
    li.appendChild(label);

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Eliminar reunión";
    deleteButton.addEventListener("click", () => deleteMeeting(meeting.folderName));
    li.appendChild(deleteButton);

    const filesEl = document.createElement("div");
    filesEl.className = "files";
    li.appendChild(filesEl);
    renderMeetingFiles(filesEl, meeting.folderName);

    listEl.appendChild(li);
  }
}

chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
  render(meetingHistory);
});
```

- [ ] **Step 2: Build + tests**

```bash
npm test
```

Expected: 13/13 (esta tarea solo toca `history.js`, que no tiene tests propios — no hay build de esbuild para este archivo, se carga como módulo nativo).

- [ ] **Step 3: Manual verification**

Abrir el historial con al menos dos reuniones grabadas. "Ver" debe abrir el archivo en una pestaña nueva (audio/video reproducible, texto legible para `.txt`/`.json`). "Descargar" sigue funcionando como antes. "Eliminar reunión" debe pedir confirmación, hacer desaparecer esa reunión de la lista, y su carpeta ya no debe existir en OPFS (confirmar que "Ver"/"Descargar" ya no la encuentran).

- [ ] **Step 4: Commit**

```bash
git add src/history/history.js
git commit -m "feat: add view-in-new-tab and delete-meeting actions to history"
```

---

## Task 16: Selector real del panel de subtítulos + leer el último bloque, no el primero + timestamps en la transcripción

Diagnóstico real contra el DOM de Meet (ver conversación de esta sesión) reveló dos cosas: (1) el selector del contenedor de subtítulos (`div[jsname="xySENc"][aria-live="polite"]`, tomado de Fireflies sin confirmar) está mal — el real es `[role="region"][aria-label="Captions"]`; (2) Meet acumula **un bloque de DOM por cada intervención** (`div.nMcdL.bj4p3b`, uno por hablante), no un solo nodo que se reemplaza — nuestra lectura usaba `querySelector` (agarra el primer bloque, siempre el más viejo) en vez de leer el último bloque (el que realmente se está actualizando en vivo). Los selectores de hablante (`.NWpY1d`) y texto (`.ygicle.VbkSUe`) sí eran correctos. De paso: se saca el CSS que ocultaba visualmente los subtítulos (pedido explícito del usuario — no hace falta ocultarlos en esta versión) y se agregan timestamps `mm:ss` a cada línea de `transcripcion.txt`, aprovechando que `CaptionParser` ya calcula `startMs`/`endMs` por intervención.

**Files:**
- Modify: `src/content/meet-selectors.js`
- Modify: `src/content/meet-caption-observer.js`
- Modify: `src/storage/session-writer.js`

- [ ] **Step 1: Modify `meet-selectors.js`** — corregir `captionsContainer` y agregar `captionUtteranceBlock`

```js
// src/content/meet-selectors.js
export const SELECTORS = {
  hangUpButton: '[aria-label="Leave call"]',
  micButton: '[aria-label*="microphone" i]',
  micMutedAttribute: "data-is-muted",
  captionsToggleButton: 'button[jsname="RrG0hf"], button[jslog^="211197"]',
  captionsContainer: '[role="region"][aria-label="Captions"]',
  captionUtteranceBlock: ".nMcdL.bj4p3b",
  captionSpeakerName: ".NWpY1d",
  captionText: ".ygicle.VbkSUe",
};
```

- [ ] **Step 2: Rewrite `meet-caption-observer.js`** — leer el último bloque de intervención (no el primer match del contenedor entero), y sacar el CSS que oculta los subtítulos

```js
// src/content/meet-caption-observer.js
import { SELECTORS } from "./meet-selectors.js";

function findCaptionsContainer() {
  return document.querySelector(SELECTORS.captionsContainer);
}

function readLatestSnapshot(container) {
  const blocks = container.querySelectorAll(SELECTORS.captionUtteranceBlock);
  if (blocks.length === 0) return null;
  const latest = blocks[blocks.length - 1];

  const speakerEl = latest.querySelector(SELECTORS.captionSpeakerName);
  const textEl = latest.querySelector(SELECTORS.captionText);
  if (!textEl) return null;

  return {
    speaker: speakerEl ? speakerEl.textContent.trim() : null,
    text: textEl.textContent.trim(),
    timestampMs: Date.now(),
  };
}

function observeCaptions(onSnapshot) {
  const container = findCaptionsContainer();
  if (!container) return () => {};

  const observer = new MutationObserver(() => {
    const snapshot = readLatestSnapshot(container);
    if (snapshot) onSnapshot(snapshot);
  });

  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

function clickCaptionsToggleOnceReady({ retries, delayMs }) {
  return new Promise((resolve) => {
    let attemptsLeft = retries;
    const tryClick = () => {
      const button = document.querySelector(SELECTORS.captionsToggleButton);
      if (button) {
        button.click();
        resolve(true);
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) {
        setTimeout(tryClick, delayMs);
      } else {
        resolve(false);
      }
    };
    tryClick();
  });
}

export async function enableCaptionsAndObserve(onSnapshot, { retries = 10, delayMs = 300 } = {}) {
  if (findCaptionsContainer()) {
    return observeCaptions(onSnapshot);
  }

  await clickCaptionsToggleOnceReady({ retries, delayMs });

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

Nota: se quitó por completo `hideCaptionsVisually()` y su estilo inyectado — el usuario pidió dejar los subtítulos visibles, no hace falta ocultarlos con CSS en esta versión.

- [ ] **Step 3: Modify `session-writer.js`** — agregar timestamps `mm:ss` a cada línea de la transcripción

```js
// src/storage/session-writer.js — agregar esta función arriba de la clase SessionWriter
function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
```

Y cambiar, dentro de `finalize()`, la línea que arma `transcriptText`:

```js
// antes:
      const transcriptText = this.captionParser.finishedSegments
        .map((segment) => `[${segment.speaker}] ${segment.text}`)
        .join("\n");

// después:
      const transcriptText = this.captionParser.finishedSegments
        .map((segment) => `[${formatTimestamp(segment.startMs)}] [${segment.speaker}] ${segment.text}`)
        .join("\n");
```

El resto de `session-writer.js` (todo lo del Task 14: OPFS, cola de escritura por stream, etc.) no cambia.

- [ ] **Step 4: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, 13/13 tests (esta tarea no toca `src/lib/`).

- [ ] **Step 5: Manual verification**

Recargar la extensión, entrar a una reunión real con al menos otra persona hablando (o narrar en voz alta un buen rato para generar varias intervenciones). Confirmar que el panel de subtítulos de Meet se ve normal en pantalla (ya no se oculta). Detener la grabación y abrir `transcripcion.txt` desde el historial ("Ver") — debe tener una línea por intervención con formato `[mm:ss] [hablante] texto`, reflejando lo que efectivamente se dijo (no solo la primera intervención repetida).

- [ ] **Step 6: Commit**

```bash
git add src/content/meet-selectors.js src/content/meet-caption-observer.js src/storage/session-writer.js
git commit -m "fix: use the real Meet captions container, read the latest utterance block, add timestamps to transcript"
```

---

## Task 17: No apagar los subtítulos si ya estaban activados

Bug real: `enableCaptionsAndObserve` decide si hace falta activar los subtítulos según si **encuentra el panel** en el DOM — pero si los subtítulos ya estaban activados de una sesión anterior de Meet (se recuerda esa preferencia por cuenta) y el panel tarda un instante en montarse, el código de todos modos hace clic en el botón, **apagando los subtítulos que ya estaban prendidos**. Fix: revisar el estado real del botón (`aria-label` dice "Turn on captions" cuando están apagados, "Turn off captions" cuando están prendidos) y solo hacer clic si confirma que están apagados.

**Files:**
- Modify: `src/content/meet-caption-observer.js`

- [ ] **Step 1: Modify `clickCaptionsToggleOnceReady`** — renombrar a `ensureCaptionsEnabled` y revisar el estado del botón antes de clicar

```js
// src/content/meet-caption-observer.js — reemplazar la función clickCaptionsToggleOnceReady
function isCaptionsCurrentlyOn(button) {
  const label = button.getAttribute("aria-label") || "";
  return label.toLowerCase().includes("turn off");
}

function ensureCaptionsEnabled({ retries, delayMs }) {
  return new Promise((resolve) => {
    let attemptsLeft = retries;
    const tryEnsure = () => {
      const button = document.querySelector(SELECTORS.captionsToggleButton);
      if (button) {
        if (!isCaptionsCurrentlyOn(button)) {
          button.click();
        }
        resolve(true);
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) {
        setTimeout(tryEnsure, delayMs);
      } else {
        resolve(false);
      }
    };
    tryEnsure();
  });
}
```

Y en `enableCaptionsAndObserve`, cambiar la llamada `await clickCaptionsToggleOnceReady({ retries, delayMs });` por `await ensureCaptionsEnabled({ retries, delayMs });`. El resto de la función (y del archivo) no cambia.

- [ ] **Step 2: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, 13/13.

- [ ] **Step 3: Manual verification**

Entrar a una reunión donde los subtítulos ya estén activados de antemano (de una sesión previa). Confirmar que el botón de subtítulos sigue diciendo "Turn off captions" (o sea, siguen activados) después de que arranca la grabación — antes se apagaban en este escenario. Confirmar que `transcripcion.txt` se genera con contenido real.

- [ ] **Step 4: Commit**

```bash
git add src/content/meet-caption-observer.js
git commit -m "fix: don't toggle off captions that were already enabled from a previous session"
```

---

## Task 18: Fundamento de diseño — tokens CSS + set de íconos compartido

Base para el rediseño visual del popup, el banner y el historial, tomado del diseño en Pencil (`/Users/ivangonzalez/.pencil/documents/58caa882-4cde-412b-a2df-a5d8e385c4bb/pencil-new.pen`, frames `jk68F`/`j2S9Y` y sus variantes `· Claro`). Ver capturas de referencia en `/private/tmp/claude-501/-Users-ivangonzalez-Documents-projects-personal-asterion/7ade1242-5606-4c2a-98b2-c5ea485078c6/scratchpad/pencil-export/{jk68F,j2S9Y,b1kjw8,rngkH}.png`.

**Files:**
- Create: `src/shared/theme.css`
- Create: `src/shared/icons.js`
- Modify: `manifest.json` (agregar `src/shared/theme.css` a `web_accessible_resources` para `https://meet.google.com/*`, y `lucide-static` como devDependency en `package.json`)

- [ ] **Step 1: Instalar `lucide-static`**

```bash
npm install --save-dev lucide-static
```

- [ ] **Step 2: Write `src/shared/theme.css`** — variables CSS con soporte claro/oscuro vía `prefers-color-scheme`, tomadas de `GetVariables()` del archivo de Pencil (dark es la base, light es el override — el producto es dark-first visualmente):

```css
:root {
  --bg: #1A1D24;
  --bg-elevated: #232734;
  --bg-button: #2B303C;
  --text-primary: #F5F7FA;
  --text-secondary: #8B93A7;
  --text-muted: #6A7386;
  --accent-blue: #3B82F6;
  --accent-green: #22C55E;
  --accent-red: #EF4444;
  --toggle-off: #3A4050;
  --border: #2C313C;
  --shadow: #00000040;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #FFFFFF;
    --bg-elevated: #F4F6F8;
    --bg-button: #ECEFF3;
    --text-primary: #1A1D24;
    --text-secondary: #5B6472;
    --text-muted: #8A93A3;
    --accent-blue: #2563EB;
    --accent-green: #16A34A;
    --accent-red: #DC2626;
    --toggle-off: #D5DAE2;
    --border: #E6E8EE;
    --shadow: #0F172A1F;
  }
}

* {
  box-sizing: border-box;
  font-family: "Inter", system-ui, sans-serif;
}
```

- [ ] **Step 3: Write `src/shared/icons.js`**

Copiar el contenido `<path>`/`<svg>` real de los siguientes 17 íconos desde los archivos ya instalados en `node_modules/lucide-static/icons/` (cada ícono es un archivo `.svg` individual ahí — leerlos directamente, no adivinar el path data): `file-text`, `monitor`, `history`, `chevron-right`, `chevron-left`, `audio-lines`, `settings`, `arrow-up-right`, `volume-2`, `mic`, `app-window`, `play`, `chevron-down`, `chevron-up`, `video`, `info`, `x`.

Exportar una función que arme el SVG con tamaño/color configurables:

```js
// src/shared/icons.js
const ICONS = {
  "file-text": `<contenido real del path de node_modules/lucide-static/icons/file-text.svg>`,
  monitor: `...`,
  history: `...`,
  "chevron-right": `...`,
  "chevron-left": `...`,
  "audio-lines": `...`,
  settings: `...`,
  "arrow-up-right": `...`,
  "volume-2": `...`,
  mic: `...`,
  "app-window": `...`,
  play: `...`,
  "chevron-down": `...`,
  "chevron-up": `...`,
  video: `...`,
  info: `...`,
  x: `...`,
};

export function icon(name, { size = 16, color = "currentColor" } = {}) {
  const inner = ICONS[name];
  if (!inner) throw new Error(`Ícono desconocido: ${name}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
```

(El valor real de cada `<contenido...>` son los elementos internos del SVG de lucide-static para ese ícono — abrir cada archivo `.svg` de `node_modules/lucide-static/icons/` y copiar su contenido interno tal cual, todos comparten el mismo `viewBox="0 0 24 24"` y atributos de stroke.)

- [ ] **Step 4: Modify `manifest.json`** — agregar `web_accessible_resources` para que el content script pueda linkear el CSS dentro de la página de Meet:

```json
  "web_accessible_resources": [
    {
      "resources": ["src/shared/theme.css"],
      "matches": ["https://meet.google.com/*"]
    }
  ]
```

- [ ] **Step 5: Build + tests**

```bash
npm test
```

Expected: 13/13 (esta tarea no toca `src/lib/`; `theme.css`/`icons.js` no se bundlean todavía — eso lo consumen las Tasks 20-22).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json manifest.json src/shared/
git commit -m "feat: add shared design tokens (light/dark) and lucide icon module"
```

---

## Task 19: Título real de la reunión (Fireflies-style) en vez de nombre por timestamp

**Files:**
- Modify: `src/content/meet-detector.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/offscreen/offscreen.js`
- Modify: `src/storage/session-writer.js`

- [ ] **Step 1: Modify `meet-detector.js`** — leer `document.title` al iniciar y mandarlo en `asterion:session-starting`

En `startRecording()`, cambiar la línea `chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId });` por:

```js
  const meetingTitle = document.title && document.title.trim() && document.title.trim() !== "Meet"
    ? document.title.trim()
    : "Reunión sin título";
  chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId, meetingTitle });
```

**Nota para la verificación manual (Step 5):** confirmar en una reunión real qué contiene realmente `document.title` — si Meet antepone algo tipo "Meet - " o pone solo el nombre, ajustar el `.trim()`/condición de fallback acá. No asumir el formato exacto sin confirmarlo.

- [ ] **Step 2: Modify `service-worker.js`** — pasar `meetingTitle` al reenviar `session-starting`, y guardarlo junto al `tabId`

```js
// service-worker.js: cambiar la rama asterion:session-starting
if (message.type === "asterion:session-starting") {
    activeSessionTabIds.set(message.sessionId, sender.tab?.id ?? null);
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ type: "asterion:session-starting", sessionId: message.sessionId, meetingTitle: message.meetingTitle });
    });
}
```

Y en `appendToHistory(meta)`, agregar `meetingTitle: meta.meetingTitle` al objeto que se guarda en `meetingHistory`.

- [ ] **Step 3: Modify `offscreen.js`** — pasar `meetingTitle` al crear el `SessionWriter`

```js
// offscreen.js: cambiar la rama asterion:session-starting
if (message.type === "asterion:session-starting") {
    if (sessions.has(message.sessionId)) return;
    const writer = new SessionWriter({ sessionId: message.sessionId, tabId: sender.tab?.id ?? null, meetingTitle: message.meetingTitle });
    sessions.set(message.sessionId, writer);
    writer.ready.catch((error) => {
      console.error("[Asterion] No se pudo iniciar el storage de la sesión:", error);
    });
}
```

- [ ] **Step 4: Modify `session-writer.js`** — usar el título para el nombre de carpeta y agregarlo a `manifest.json`/al retorno de `finalize()`

```js
// arriba del archivo, agregar:
function sanitizeForFolderName(text) {
  return text.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80).trim() || "Reunión";
}

function meetingFolderName(startedAt, meetingTitle) {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `${sanitizeForFolderName(meetingTitle)} — ${iso}`;
}
```

En el constructor de `SessionWriter`, agregar `this.meetingTitle = meetingTitle || "Reunión sin título";` y cambiar la llamada dentro de `_init()` de `meetingFolderName(this.startedAt)` a `meetingFolderName(this.startedAt, this.meetingTitle)`.

En `finalize()`, agregar `meetingTitle: this.meetingTitle` tanto al objeto que se escribe en `manifest.json` como al objeto que se retorna (para que `session-finalized` → `meetingHistory` lo reciba).

- [ ] **Step 5: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, 13/13.

- [ ] **Step 6: Manual verification**

Entrar a una reunión real de Meet (con nombre de calendario si es posible, y también probar una reunión ad-hoc sin nombre asignado) y confirmar qué contiene `document.title` en cada caso (ajustar el fallback del Step 1 si hace falta). Grabar y confirmar que la carpeta, `manifest.json` y la entrada de `chrome.storage.local.meetingHistory` reflejan el título real.

- [ ] **Step 7: Commit**

```bash
git add src/content/meet-detector.js src/background/service-worker.js src/offscreen/offscreen.js src/storage/session-writer.js
git commit -m "feat: use the real Meet meeting title instead of a timestamp-only name"
```

---

## Task 20: Rediseño del popup

Implementa el diseño de Pencil (frame `jk68F`, ver captura en `/private/tmp/claude-501/-Users-ivangonzalez-Documents-projects-personal-asterion/7ade1242-5606-4c2a-98b2-c5ea485078c6/scratchpad/pencil-export/jk68F.png`). Usa `src/shared/theme.css` (Task 18, variables de color) y `src/shared/icons.js` (Task 18, función `icon(name, {size, color})`).

**Estados a implementar** (uno visible a la vez, según `state` que ya devuelve `asterion:get-status`, más los datos nuevos del Step 1):

- **Listo** (`state === "idle"`, auto-inicio activado): punto verde (`--accent-green`), título "Listo", texto "Abre una reunión de Google Meet para comenzar."
- **Inactivo** (`state === "idle"`, auto-inicio **desactivado**): punto gris (`--text-muted`), título "Inactivo", texto "La extensión está deshabilitada."
- **Reunión detectada** (`state === "idle"` pero `inMeeting === true` — pasa cuando el auto-inicio está desactivado y hay una reunión sin grabar): punto azul (`--accent-blue`), título "Reunión detectada", texto "Puedes iniciar la captura desde la reunión.", tarjeta con ícono `monitor`, texto "Reunión en curso", el `meetingTitle`, y botón "Ir a la reunión ↗" (ícono `arrow-up-right`) que hace `chrome.tabs.update(activeTabId, {active: true})` y `chrome.windows.update` para enfocar esa pestaña/ventana.
- **Grabando** (`state === "recording"` o `"video-enabled"`): punto rojo, título "Grabando", `meetingTitle` en grande, timer `mm:ss` corriendo (actualizado cada segundo con `setInterval`, calculado desde `startedAt`), y 4 filas de fuente con ícono + label + punto de color + texto de estado a la derecha:
  - "Transcripción" (ícono `file-text`) — verde "Activa" si `hasTranscript` es true, gris "No disponible" si no.
  - "Audio de la reunión" (ícono `volume-2`) — siempre verde "Activo" mientras se está grabando.
  - "Mi voz" (ícono `mic`) — verde "Activa" si `!micMuted`, gris "Silenciada" si `micMuted`.
  - "Video de la pestaña" (ícono `app-window`) — verde "Activo" si `videoEnabled`, gris "No activo" si no.
- **Error** (`state === "error"`): punto rojo, título "Error", texto "No se pudo iniciar la grabación. Volvé a intentarlo."

**Persistente en todos los estados:**
- Header: ícono `audio-lines` + "Asterion" en negrita, ícono `settings` a la derecha (por ahora sin acción — dejar el toggle de auto-inicio siempre visible en el cuerpo, no hace falta una pantalla de ajustes separada).
- Fila de auto-inicio: ícono `monitor` + "Conectarse automáticamente" + interruptor (usar `--accent-blue` cuando está activo, `--toggle-off` cuando no), con texto de ayuda "Inicia la captura al entrar a una llamada de Meet." debajo.
- Fila "Ver historial": ícono `history` + "Ver historial" + ícono `chevron-right`, abre `history.html` en pestaña nueva (`chrome.tabs.create`).

**Explícitamente fuera de este rediseño:** no hay ningún texto de transcripción en vivo — se quita por completo el `<div id="transcript">`, `CaptionParser`, y `renderTranscript()` que existían antes. El popup solo necesita saber SI hay actividad de transcripción (booleano), no el contenido.

**Files:**
- Modify: `src/content/meet-detector.js` (extender el estado expuesto a `asterion:get-status`)
- Rewrite: `src/popup/popup.html`
- Rewrite: `src/popup/popup.js`

- [ ] **Step 1: Modify `meet-detector.js`** — trackear y exponer `meetingTitle`, `startedAt`, `hasTranscript`, `micMuted`, `videoEnabled`

Agregar variables de módulo junto a `sessionId`/`currentState`:

```js
let meetingTitle = null;
let startedAt = null;
let hasTranscript = false;
let micMuted = true;
let videoEnabled = false;
```

En `startRecording()`, junto con calcular `meetingTitle` (ya existe del Task 19), agregar `startedAt = Date.now();`, `hasTranscript = false;`, `videoEnabled = false;`.

En el callback de `observeMuteState`, actualizar `micMuted = muted;` (además de lo que ya hace).

En el callback de `enableCaptionsAndObserve`, dentro de la función que arma el snapshot y llama `chrome.runtime.sendMessage({type:"asterion:caption-snapshot",...})`, agregar `hasTranscript = true;` antes de mandar el mensaje.

En el listener de mensajes de `MAIN world`, en la rama `"asterion:video-enabled"`, agregar `videoEnabled = true;`.

En el listener de `chrome.runtime.onMessage` que responde `"asterion:get-status"`, cambiar el `sendResponse` para incluir los nuevos campos:

```js
sendResponse({
  inMeeting: isInActiveMeeting(),
  state: currentState,
  meetingTitle,
  startedAt,
  hasTranscript,
  micMuted,
  videoEnabled,
});
```

Al volver a `"idle"` (en la rama `"asterion:session-ended"` del listener de `MAIN world`), resetear `meetingTitle = null; startedAt = null; hasTranscript = false; videoEnabled = false;`.

- [ ] **Step 2: Rewrite `popup.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Asterion</title>
    <link rel="stylesheet" href="../shared/theme.css" />
    <style>
      body { width: 320px; padding: 16px; background: var(--bg); }
      .card { display: flex; flex-direction: column; gap: 16px; }
      .header { display: flex; justify-content: space-between; align-items: center; }
      .brand { display: flex; align-items: center; gap: 8px; color: var(--text-primary); font-weight: 600; font-size: 15px; }
      .status-row { display: flex; align-items: center; gap: 8px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .status-title { color: var(--text-primary); font-weight: 600; font-size: 14px; }
      .status-copy { color: var(--text-secondary); font-size: 13px; line-height: 1.4; }
      .meeting-name { color: var(--text-primary); font-weight: 600; font-size: 18px; }
      .timer { color: var(--text-secondary); font-size: 13px; }
      .source-row { display: flex; justify-content: space-between; align-items: center; }
      .source-left { display: flex; align-items: center; gap: 10px; color: var(--text-primary); font-size: 13px; }
      .source-status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
      .toggle-row { display: flex; justify-content: space-between; align-items: center; }
      .toggle { width: 42px; height: 24px; border-radius: 12px; padding: 3px; display: flex; align-items: center; cursor: pointer; }
      .toggle-knob { width: 18px; height: 18px; border-radius: 50%; background: #FFFFFF; transition: transform 0.15s; }
      .helper { color: var(--text-muted); font-size: 12px; line-height: 1.35; }
      .link-row { display: flex; justify-content: space-between; align-items: center; cursor: pointer; color: var(--text-primary); font-size: 14px; }
      .card-box { background: var(--bg-elevated); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      button.primary { width: 100%; background: var(--bg-button); color: var(--text-primary); border: none; border-radius: 10px; padding: 10px; font-size: 14px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
    </style>
  </head>
  <body>
    <div id="app" class="card"></div>
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

(Todo el contenido de `#app` se arma en JS por estado — no hay markup fijo de estado acá, para no duplicar estructura entre los 5 estados.)

- [ ] **Step 3: Rewrite `popup.js`**

Estructura general (sin transcripción en vivo, sin `CaptionParser`):

```js
// src/popup/popup.js
import { icon } from "../shared/icons.js";

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
    <div class="toggle-row">
      <div class="source-left">${icon("monitor", { size: 16, color: "var(--text-secondary)" })}<span style="color:var(--text-primary)">Conectarse automáticamente</span></div>
      <div id="auto-start-toggle" class="toggle" style="background:${autoStart ? "var(--accent-blue)" : "var(--toggle-off)"};justify-content:${autoStart ? "flex-end" : "flex-start"}">
        <div class="toggle-knob"></div>
      </div>
    </div>
    <div class="helper">Inicia la captura al entrar a una llamada de Meet.</div>
    <div id="history-link" class="link-row">
      <div class="source-left">${icon("history", { size: 16, color: "var(--text-secondary)" })}<span>Ver historial</span></div>
      ${icon("chevron-right", { size: 16, color: "var(--text-secondary)" })}
    </div>
  `;
}

function header() {
  return `<div class="header">
    <div class="brand">${icon("audio-lines", { size: 18, color: "var(--text-primary)" })}Asterion</div>
    ${icon("settings", { size: 18, color: "var(--text-secondary)" })}
  </div>`;
}

function render(status, autoStart) {
  if (timerInterval) clearInterval(timerInterval);

  if (!status || !status.inMeeting) {
    const inactive = !autoStart;
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:${inactive ? "var(--text-muted)" : "var(--accent-green)"}"></span><span class="status-title">${inactive ? "Inactivo" : "Listo"}</span></div>
      <div class="status-copy">${inactive ? "La extensión está deshabilitada." : "Abre una reunión de Google Meet para comenzar."}</div>
      ${footer(autoStart)}`;
    wireFooter(autoStart);
    return;
  }

  if (status.state === "idle") {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-blue)"></span><span class="status-title">Reunión detectada</span></div>
      <div class="status-copy">Puedes iniciar la captura desde la reunión.</div>
      <div class="card-box">
        <div class="source-left">${icon("monitor", { size: 16, color: "var(--accent-blue)" })}<span style="color:var(--text-secondary);font-size:12px">Reunión en curso</span></div>
        <div class="meeting-name">${status.meetingTitle ?? "Reunión sin título"}</div>
        <button class="primary" id="go-to-meeting">Ir a la reunión ${icon("arrow-up-right", { size: 14 })}</button>
      </div>
      ${footer(autoStart)}`;
    document.getElementById("go-to-meeting").addEventListener("click", () => {
      chrome.tabs.update(activeTabId, { active: true });
    });
    wireFooter(autoStart);
    return;
  }

  if (status.state === "error") {
    appEl.innerHTML = `${header()}
      <div class="status-row"><span class="dot" style="background:var(--accent-red)"></span><span class="status-title">Error</span></div>
      <div class="status-copy">No se pudo iniciar la grabación. Volvé a intentarlo.</div>
      ${footer(autoStart)}`;
    wireFooter(autoStart);
    return;
  }

  // recording / video-enabled
  appEl.innerHTML = `${header()}
    <div class="status-row"><span class="dot" style="background:var(--accent-red)"></span><span class="status-title">Grabando</span></div>
    <div class="meeting-name">${status.meetingTitle ?? "Reunión sin título"}</div>
    <div class="timer" id="timer">00:00</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      ${sourceRow("file-text", "Transcripción", status.hasTranscript, "Activa", "No disponible")}
      ${sourceRow("volume-2", "Audio de la reunión", true, "Activo", "")}
      ${sourceRow("mic", "Mi voz", !status.micMuted, "Activa", "Silenciada")}
      ${sourceRow("app-window", "Video de la pestaña", status.videoEnabled, "Activo", "No activo")}
    </div>
    ${footer(autoStart)}`;
  wireFooter(autoStart);

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
}

async function refresh() {
  const { autoStart } = await chrome.storage.local.get({ autoStart: true });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.startsWith("https://meet.google.com/")) {
    activeTabId = null;
    render(null, autoStart);
    return;
  }
  activeTabId = tab.id;
  chrome.tabs.sendMessage(tab.id, { type: "asterion:get-status" }, (response) => {
    render(chrome.runtime.lastError ? null : response, autoStart);
  });
}

refresh();
setInterval(refresh, 2000);
```

- [ ] **Step 4: Build + tests**

```bash
npm test
```

Expected: 13/13 (esta tarea no toca `src/lib/`; `popup.js`/`popup.html` no se bundlean, se cargan como módulos nativos).

- [ ] **Step 5: Manual verification**

Cargar la extensión, probar cada estado: sin reunión (con auto-inicio activado y desactivado → Listo/Inactivo), con reunión detectada sin grabar (auto-inicio desactivado), grabando (confirmar timer corriendo y las 4 filas reflejando mute/video real), y forzar un error (por ejemplo revocando algún permiso) para ver el estado rojo. Confirmar que no aparece ningún texto de transcripción en el popup, y que el tema cambia solo al cambiar el tema del sistema operativo (`prefers-color-scheme`).

- [ ] **Step 6: Commit**

```bash
git add src/content/meet-detector.js src/popup/popup.html src/popup/popup.js
git commit -m "feat: redesign popup per Pencil design (states, timer, source status, no live transcript)"
```

---

## Task 21: Rediseño del menú flotante en la página de Meet

Implementa el diseño de Pencil (frame `j2S9Y`, ver captura en `.../scratchpad/pencil-export/j2S9Y.png`). Usa Shadow DOM para aislar los estilos del banner de los de la propia página de Meet (evita colisiones de CSS con las clases internas de Meet).

**Estados:** Reunión detectada (botón azul "Iniciar captura" con ícono `play`), Grabando colapsado (punto rojo + "Asterion"/timer + ícono `video` para activar cámara — sigue siendo el único lugar donde se engancha el clic real de `getDisplayMedia()` vía `data-asterion-enable-video`, no tocar esa restricción del Task 6 — + botón rojo "Detener" + chevron para expandir/contraer), Grabando expandido (mismo top bar + separador + las mismas 4 filas de fuente que el popup + texto informativo con ícono `info`: "Se está grabando la reunión. Puedes detener la captura en cualquier momento."), Captura finalizada (ícono de check verde, "Captura finalizada"/"La reunión se guardó correctamente.", botón "Ver grabación" con ícono `arrow-up-right`, ícono `x` para cerrar), Error (mismo patrón colapsado con punto rojo, "Error"/"No se pudo iniciar").

**Files:**
- Rewrite: `src/content/meet-banner.js`
- Modify: `src/content/meet-detector.js` (wiring del nuevo banner)

- [ ] **Step 1: Rewrite `meet-banner.js`** con Shadow DOM

Estructura general: un `<div id="asterion-banner-host">` en `document.body`, con `attachShadow({mode:"open"})`; dentro del shadow root, un `<link rel="stylesheet" href="${chrome.runtime.getURL('src/shared/theme.css')}">` (el manifest ya lo declara `web_accessible_resources` en la Task 18) más un `<style>` con las clases propias del banner (pill totalmente redondeada, `border-radius: 999px` para el estado colapsado, `border-radius: 20px` para el expandido/finalizada), y un contenedor `#content` donde se renderiza cada estado, con la misma función `icon()` de `src/shared/icons.js`.

Mantener la misma API pública que usa `meet-detector.js` hoy: `showBanner({ onStart, onStop })` y `updateBannerState(state, meta)` — pero `updateBannerState` ahora también necesita recibir `meetingTitle`/`startedAt` para el timer y el nombre, y una función para expandir/contraer que se guarda en un estado interno del módulo (no hace falta exponerla afuera). El botón con `data-asterion-enable-video` debe existir siempre que el estado sea "recording"/"video-enabled" (dentro del shadow root — el bootstrap `MAIN world` sigue reconociendo el atributo `data-asterion-enable-video` sin importar si está dentro de un shadow root, `document.addEventListener("click", ..., true)` con `event.target.closest(...)` no atraviesa shadow boundaries por defecto — **validar esto explícitamente en la verificación manual**, y si `closest` no encuentra el botón por estar dentro del shadow root, usar `event.composedPath()` para buscarlo ahí en vez de `event.target.closest(...)`).

Agregar el estado "Captura finalizada": se muestra cuando `meet-detector.js` recibe la confirmación de que se guardó (ver Step 2), con un botón "Ver grabación" que abre el archivo de audio de esa reunión — como el nombre de carpeta ahora incluye el título (Task 19) pero el content script no tiene acceso directo a OPFS del offscreen document, alcanza con abrir el historial (`chrome.tabs.create` a `history.html`) en vez de intentar abrir el archivo directo desde acá.

- [ ] **Step 2: Modify `meet-detector.js`** — mostrar "Captura finalizada" tras confirmar el guardado

El content script hoy solo sabe que terminó la sesión (`asterion:session-ended`), no que el offscreen document efectivamente terminó de escribir los archivos (`asterion:session-finalized`, que hoy solo lo escucha el service worker). Agregar un listener para ese mensaje también acá:

```js
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "asterion:session-finalized") {
    showFinishedBanner();
  }
});
```

(`showFinishedBanner` es una función nueva exportada por `meet-banner.js` en el Step 1, que muestra el estado "Captura finalizada" durante unos segundos o hasta que el usuario lo cierre.)

- [ ] **Step 3: Build + tests**

```bash
npm run build:content
npm test
```

Expected: build limpio, 13/13.

- [ ] **Step 4: Manual verification**

Entrar a una reunión real. Confirmar: el banner se ve como una píldora redondeada consistente con el diseño, sin heredar ningún estilo de Meet (probar en modo claro y oscuro del sistema operativo); el botón de activar video sigue disparando el diálogo nativo de Chrome (validar específicamente que `data-asterion-enable-video` sigue siendo detectado desde el bootstrap `MAIN world` a través del Shadow DOM — si no, aplicar el fix de `composedPath()` mencionado arriba); expandir/contraer funciona; al detener, aparece brevemente "Captura finalizada" con el botón "Ver grabación" abriendo el historial.

- [ ] **Step 5: Commit**

```bash
git add src/content/meet-banner.js src/content/meet-detector.js
git commit -m "feat: redesign in-page banner per Pencil design with Shadow DOM isolation"
```

---

## Task 23: El banner sale sin fondo — `:root` no existe dentro de un Shadow DOM

Bug real encontrado al probar el banner rediseñado (Task 21): sale sin fondo (transparente). Causa: `src/shared/theme.css` define las variables de color con el selector `:root`, pero `:root` solo matchea el elemento raíz del documento (`<html>`) — **no matchea nada dentro de un Shadow DOM**, que es donde vive el contenido del banner desde la Task 21. Como resultado, ninguna variable (`--bg`, `--text-primary`, etc.) queda definida dentro del banner, y todos los `var(--bg)` etc. caen al valor inicial (transparente).

**Files:**
- Modify: `src/shared/theme.css`

- [ ] **Step 1: Cambiar `:root` por `:root, :host` en ambos bloques**

```css
:root, :host {
  --bg: #1A1D24;
  --bg-elevated: #232734;
  --bg-button: #2B303C;
  --text-primary: #F5F7FA;
  --text-secondary: #8B93A7;
  --text-muted: #6A7386;
  --accent-blue: #3B82F6;
  --accent-green: #22C55E;
  --accent-red: #EF4444;
  --toggle-off: #3A4050;
  --border: #2C313C;
  --shadow: #00000040;
}

@media (prefers-color-scheme: light) {
  :root, :host {
    --bg: #FFFFFF;
    --bg-elevated: #F4F6F8;
    --bg-button: #ECEFF3;
    --text-primary: #1A1D24;
    --text-secondary: #5B6472;
    --text-muted: #8A93A3;
    --accent-blue: #2563EB;
    --accent-green: #16A34A;
    --accent-red: #DC2626;
    --toggle-off: #D5DAE2;
    --border: #E6E8EE;
    --shadow: #0F172A1F;
  }
}

* {
  box-sizing: border-box;
  font-family: "Inter", system-ui, sans-serif;
}
```

(`:host` no hace nada fuera de un Shadow DOM, y `:root` no hace nada dentro de uno — combinarlos en la misma regla hace que el mismo archivo sirva para el popup/historial (documentos normales) y para el banner (Shadow DOM) sin duplicar el archivo.)

- [ ] **Step 2: Build + tests**

```bash
npm test
```

Expected: 13/13 (este archivo no se bundlea ni tiene tests propios).

- [ ] **Step 3: Manual verification**

Recargar la extensión, entrar a una reunión, confirmar que el banner ahora sí tiene fondo (oscuro por defecto, claro si el sistema operativo está en modo claro) igual que el popup.

- [ ] **Step 4: Commit**

```bash
git add src/shared/theme.css
git commit -m "fix: define theme.css tokens on :host too so they apply inside the banner's Shadow DOM"
```

---

## Task 24: El video grabado debe incluir audio (la misma mezcla ya existente)

Pedido del usuario: hoy `video-reunion.webm` se graba sin audio (`getDisplayMedia({video: true, preferCurrentTab: true})` nunca pide audio). Debe incluir audio — pero no una captura nueva: la **misma pista ya mezclada** (audio de los demás participantes + voz propia, con el `GainNode` de mute ya aplicado) que ya alimenta el archivo de audio separado. Una pista de `MediaStreamTrack` puede agregarse a más de un `MediaStream` a la vez sin problema, así que alcanza con combinarla con la pista de video al armar el stream que graba el `MediaRecorder` de video.

**Files:**
- Modify: `src/webrtc-bootstrap/session.js`

- [ ] **Step 1: Modify `enableVideo`** — combinar la pista de video de `displayStream` con la pista de audio de `this.mixer.stream`

```js
// src/webrtc-bootstrap/session.js
  enableVideo(displayStream) {
    if (this.videoRecorder) return;
    this.videoStream = displayStream;

    const videoTrack = displayStream.getVideoTracks()[0];
    const audioTrack = this.mixer.stream.getAudioTracks()[0];
    const recordedStream = new MediaStream(
      audioTrack ? [videoTrack, audioTrack] : [videoTrack]
    );

    const { recorder, waitForPendingWrites } = this._startRecorder(recordedStream, "video", "video/webm");
    this.videoRecorder = recorder;
    this._videoWrites = waitForPendingWrites;
  }
```

No cambia nada más del archivo — en particular, `stop()` sigue deteniendo las pistas de `this.videoStream` (que sigue siendo solo el stream de `getDisplayMedia`, sin la pista de audio agregada), así que detener el video no corta accidentalmente la pista de audio que sigue alimentando el archivo de audio combinado.

- [ ] **Step 2: Build + tests**

```bash
npm run build:webrtc
npm test
```

Expected: build limpio, 13/13.

- [ ] **Step 3: Manual verification**

Activar video durante una grabación real, hablar (propio y de otro participante), detener, y confirmar que `video-reunion.webm` tiene audio sincronizado con el video (no solo el archivo `audio-reunion.webm` por separado).

- [ ] **Step 4: Commit**

```bash
git add src/webrtc-bootstrap/session.js
git commit -m "feat: include the combined meeting+mic audio track in the recorded video file"
```

---

## Task 22: Restyle del historial

**Files:**
- Rewrite: `src/history/history.html`
- Modify: `src/history/history.js`

- [ ] **Step 1: Rewrite `history.html`** — mismo lenguaje visual que el popup (usar `src/shared/theme.css`), con un header "← Historial" (ícono `chevron-left` + "Historial", el ícono navega hacia atrás con `history.back()` o simplemente cierra la pestaña) en vez del header con logo, y una lista de tarjetas por reunión.

- [ ] **Step 2: Modify `history.js`** — usar `meetingTitle` (ya viene en `chrome.storage.local.meetingHistory` desde la Task 19) como título principal de cada tarjeta en vez de `folderName`, con la fecha relativa al estilo del diseño ("Hoy · 18 min", "Ayer · 42 min", usando `startedAt` y la duración — calcular duración real a partir del archivo `audio-reunion.webm` con `file.size`/bitrate estimado no es preciso; más simple: guardar la duración real en el manifiesto en un futuro ajuste, por ahora usar el tiempo transcurrido entre `startedAt` y cuando se recibió `session-finalized`, que se puede aproximar con `Date.now()` al momento de guardar en `appendToHistory` del service worker — si no está disponible con precisión, mostrar solo la fecha sin duración en vez de inventar un número). Mantener las acciones Ver/Descargar/Eliminar ya implementadas (Tasks 14-15), solo restyleadas visualmente.

- [ ] **Step 3: Build + tests**

```bash
npm test
```

- [ ] **Step 4: Manual verification**

Abrir el historial con reuniones ya grabadas, confirmar que el título mostrado es el título real de la reunión (no el nombre de carpeta), que el tema claro/oscuro se aplica igual que en el popup, y que Ver/Descargar/Eliminar siguen funcionando.

- [ ] **Step 5: Commit**

```bash
git add src/history/history.html src/history/history.js
git commit -m "feat: restyle history view to match Pencil design and show real meeting titles"
```

---

## Task 25: Dependencias de ffmpeg + copia de los binarios en build-time (sin comprometerlos a git)

Vamos a producir MP3/MP4 reales de la reunión (audio y video), igual que hace Fireflies (confirmado inspeccionando su extensión instalada: usa `@ffmpeg/ffmpeg` + `@ffmpeg/core` reales, no un truco liviano). Los binarios de `ffmpeg-core` (~24-31MB) nunca deben comprometerse a git: llegan a `node_modules` vía `npm install` normal (ya gitignoreado) y un script de build los copia a `dist/ffmpeg/` (dentro de `dist/`, también gitignoreado).

**Files:**
- Modify: `package.json`
- Create: `scripts/copy-ffmpeg-core.js`
- Modify: `.gitignore`

- [ ] **Step 1: Instalar dependencias** — `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@ffmpeg/core` (pinear versiones exactas de la línea 0.12.x estable actual; usar `@ffmpeg/core` single-thread, **nunca** `@ffmpeg/core-mt` — el multi-hilo requiere `SharedArrayBuffer` + `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`, inviable en una página `chrome-extension://`)

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/util @ffmpeg/core
```

- [ ] **Step 2: Create `scripts/copy-ffmpeg-core.js`** — script Node sin red, copia los archivos ya descargados por npm hacia `dist/ffmpeg/`

```js
// scripts/copy-ffmpeg-core.js
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SRC_DIR = "node_modules/@ffmpeg/core/dist/esm";
const DEST_DIR = "dist/ffmpeg";
const FILES = ["ffmpeg-core.js", "ffmpeg-core.wasm"];

await mkdir(DEST_DIR, { recursive: true });
for (const file of FILES) {
  const src = `${SRC_DIR}/${file}`;
  if (!existsSync(src)) {
    throw new Error(`No se encontró ${src} — revisar el layout real de node_modules/@ffmpeg/core/dist`);
  }
  await copyFile(src, `${DEST_DIR}/${file}`);
}
console.log(`Copiados ${FILES.length} archivos de ffmpeg-core a ${DEST_DIR}/`);
```

Antes de dar este paso por terminado, verificar el layout real de `node_modules/@ffmpeg/core/dist/` (puede ser `esm/` o `umd/` según la versión instalada) y ajustar `SRC_DIR` — no asumir la ruta de memoria.

- [ ] **Step 3: Modify `package.json`** — nuevo script `copy:ffmpeg`, agregado a la cadena de `build`

```json
"scripts": {
  "test": "vitest run",
  "build:content": "esbuild src/content/meet-detector.js --bundle --outfile=dist/content.bundle.js",
  "build:webrtc": "esbuild src/webrtc-bootstrap/bootstrap.js --bundle --outfile=dist/webrtc-bootstrap.bundle.js",
  "copy:ffmpeg": "node scripts/copy-ffmpeg-core.js",
  "build": "npm run build:content && npm run build:webrtc && npm run copy:ffmpeg"
}
```

(El target `build:offscreen` de la Task 27 se agrega después, al final de esta misma cadena.)

- [ ] **Step 4: Modify `.gitignore`** — comentario aclaratorio (el binario ya queda cubierto por `dist/`, esto es solo para que quede explícito que es deliberado)

```
node_modules/
dist/ # incluye dist/ffmpeg/ (binarios de ffmpeg-core copiados en build-time, nunca committeados)
```

- [ ] **Step 5: Verificación**

```bash
npm install
npm run build
ls dist/ffmpeg/
```

Expected: `ffmpeg-core.js` y `ffmpeg-core.wasm` presentes en `dist/ffmpeg/`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/copy-ffmpeg-core.js .gitignore
git commit -m "build: add ffmpeg.wasm dependencies with a build-time copy step (no binaries committed)"
```

---

## Task 26: CSP de la extensión para permitir WASM en el offscreen document

`ffmpeg.wasm` necesita instanciar WebAssembly, y el CSP default de Manifest V3 (`script-src 'self'; object-src 'self'`) no lo permite. Hay que agregar `'wasm-unsafe-eval'` explícitamente — es la única relajación que Chrome permite para `extension_pages` en este caso.

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Modify `manifest.json`** — agregar la clave `content_security_policy` (no existe hoy)

```json
{
  "manifest_version": 3,
  "name": "Asterion — Captura de Reuniones",
  "version": "0.1.0",
  "description": "Captura local automática de transcripción, audio y video de reuniones de Google Meet.",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "offscreen", "scripting", "unlimitedStorage", "downloads"],
  "host_permissions": ["https://meet.google.com/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "web_accessible_resources": [
    {
      "resources": ["src/shared/theme.css"],
      "matches": ["https://meet.google.com/*"]
    }
  ],
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

No se toca `web_accessible_resources` — los archivos de `ffmpeg-core` se consumen desde el propio origen del offscreen document (`chrome-extension://<id>/dist/ffmpeg/...`) vía `chrome.runtime.getURL`, no necesitan exponerse a otro origen (eso solo aplica para recursos que un origen externo, como `meet.google.com`, necesite cargar).

- [ ] **Step 2: Verificación**

Cargar la extensión sin empaquetar en `chrome://extensions` (modo desarrollador) y confirmar que no aparece ningún error de manifest inválido.

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "fix: allow wasm-unsafe-eval on extension pages for ffmpeg.wasm"
```

---

## Task 27: Build (bundling) del offscreen document

Hoy `offscreen.js` se carga como módulo ES nativo sin bundling (`<script type="module" src="offscreen.js">`). Los paquetes de ffmpeg.wasm son dependencias de `node_modules` con su propio grafo de imports — hace falta bundlearlos con esbuild como ya se hace con `content.bundle.js`/`webrtc-bootstrap.bundle.js`.

**Files:**
- Modify: `package.json`
- Modify: `src/offscreen/offscreen.html`

- [ ] **Step 1: Modify `package.json`** — nuevo script `build:offscreen`, agregado al final de la cadena de `build`

```json
"scripts": {
  "test": "vitest run",
  "build:content": "esbuild src/content/meet-detector.js --bundle --outfile=dist/content.bundle.js",
  "build:webrtc": "esbuild src/webrtc-bootstrap/bootstrap.js --bundle --outfile=dist/webrtc-bootstrap.bundle.js",
  "build:offscreen": "esbuild src/offscreen/offscreen.js --bundle --format=esm --outfile=dist/offscreen.bundle.js",
  "copy:ffmpeg": "node scripts/copy-ffmpeg-core.js",
  "build": "npm run build:content && npm run build:webrtc && npm run copy:ffmpeg && npm run build:offscreen"
}
```

- [ ] **Step 2: Modify `src/offscreen/offscreen.html`** — apuntar al bundle en vez del módulo nativo

```html
<!-- src/offscreen/offscreen.html -->
<script type="module" src="../../dist/offscreen.bundle.js"></script>
```

- [ ] **Step 3: Build + smoke test manual**

```bash
npm run build
```

Expected: `dist/offscreen.bundle.js` generado sin errores. Recargar la extensión y abrir la consola del offscreen document (`chrome://extensions` → detalles de Asterion → "Inspeccionar vistas" → offscreen.html) para confirmar que no hay errores de carga de módulo. Prestar atención especial a que esbuild no rompa el patrón interno de `new Worker(...)`/`new URL(..., import.meta.url)` que usa `@ffmpeg/ffmpeg` — es un riesgo conocido de bundling con paquetes que instancian Workers dinámicamente, requiere verificación manual, no solo que el build no tire error.

- [ ] **Step 4: Commit**

```bash
git add package.json src/offscreen/offscreen.html
git commit -m "build: bundle the offscreen document with esbuild"
```

---

## Task 28: Cliente/cola global de ffmpeg en el offscreen document

`ffmpeg.wasm` no es reentrante (un worker, un filesystem virtual interno) — no se pueden correr dos `exec()` en simultáneo sobre la misma instancia. Este módulo centraliza una única instancia de `FFmpeg`, cargada una sola vez, con una cola FIFO para serializar los trabajos.

**Files:**
- Create: `src/offscreen/ffmpeg-client.js`

- [ ] **Step 1: Create `src/offscreen/ffmpeg-client.js`**

```js
// src/offscreen/ffmpeg-client.js
import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpegInstance = null;
let loadPromise = null;
let queueTail = Promise.resolve();

async function getFfmpeg() {
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg();
  }
  if (!loadPromise) {
    loadPromise = ffmpegInstance.load({
      coreURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("dist/ffmpeg/ffmpeg-core.wasm"),
    });
  }
  await loadPromise;
  return ffmpegInstance;
}

let jobCounter = 0;

// Encola el trabajo detrás de cualquier otro ya en curso — nunca se corren dos
// exec() en simultáneo sobre la misma instancia de ffmpeg.
export function runFfmpegJob({ inputBytes, inputExt, outputExt, args }) {
  const result = queueTail.then(() => _runJob({ inputBytes, inputExt, outputExt, args }));
  // Si este job falla, la cola debe seguir viva para el siguiente — no propagar el
  // rechazo hacia queueTail.
  queueTail = result.catch(() => {});
  return result;
}

async function _runJob({ inputBytes, inputExt, outputExt, args }) {
  const jobId = ++jobCounter;
  const inputName = `input_${jobId}.${inputExt}`;
  const outputName = `output_${jobId}.${outputExt}`;
  const startedAt = Date.now();
  console.log(`[Asterion ffmpeg] job ${jobId}: iniciando (${inputBytes.byteLength} bytes de entrada)`);

  const ffmpeg = await getFfmpeg();
  try {
    await ffmpeg.writeFile(inputName, inputBytes);
    await ffmpeg.exec(["-i", inputName, ...args, outputName]);
    const outputData = await ffmpeg.readFile(outputName);
    if (!outputData || outputData.byteLength === 0) {
      throw new Error("ffmpeg produjo un archivo de salida vacío");
    }
    console.log(
      `[Asterion ffmpeg] job ${jobId}: terminado en ${Date.now() - startedAt}ms (${outputData.byteLength} bytes de salida)`
    );
    return outputData;
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
```

No se agrega ningún timeout que cancele el job — solo logging informativo de tiempos y tamaños, por decisión explícita del usuario de no limitar el cómputo que haga falta.

- [ ] **Step 2: Verificación manual**

No depende de OPFS ni de una reunión real. Cargar la extensión, abrir la consola del offscreen document, e invocar `runFfmpegJob` manualmente con un archivo webm pequeño de prueba (por ejemplo, uno ya grabado en `dist/` o un fixture) para confirmar que produce una salida válida antes de integrarlo con `SessionWriter` en la Task 29.

- [ ] **Step 3: Commit**

```bash
git add src/offscreen/ffmpeg-client.js
git commit -m "feat: add a serialized ffmpeg.wasm job queue for the offscreen document"
```

---

## Task 29: Integrar la conversión de audio/video en `SessionWriter`

`finalize()` no debe esperar a que termine la conversión — un video de varias horas puede tardar mucho más que la propia reunión en transcodificarse. Los webm originales quedan disponibles de inmediato (la sesión se marca "finalizada" ahí); la conversión a MP3/MP4 corre como trabajo de fondo, secuencial (primero audio, después video, nunca en paralelo — ambos comparten la única cola de `ffmpeg-client`), y actualiza `manifest.json` cuando termina. El webm original nunca se borra, sin importar el resultado.

**Files:**
- Modify: `src/storage/session-writer.js`
- Modify: `src/offscreen/offscreen.js`

- [ ] **Step 1: Modify `finalize()` en `session-writer.js`** — el manifest inicial incluye el estado de conversión "pending", y se dispara `scheduleConversions()` sin esperarlo

```js
// src/storage/session-writer.js
  async finalize({ muteManifest }) {
    await this.ready;
    this.captionParser.finalizeCurrent(Date.now());

    await Promise.all(this.writeQueueByStream.values());

    for (const writable of this.writablesByStream.values()) {
      await writable.close();
    }

    if (this.hasCaption) {
      const transcriptText = this.captionParser.finishedSegments
        .map((segment) => `[${formatTimestamp(segment.startMs)}] [${segment.speaker}] ${segment.text}`)
        .join("\n");
      const fileHandle = await this.meetingHandle.getFileHandle("transcripcion.txt", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(transcriptText);
      await writable.close();
    }

    this.hasVideo = this.streamsUsed.has("video");
    await this._writeManifest({
      muteManifest,
      audioConversionStatus: this.streamsUsed.has("meeting") ? "pending" : "skipped",
      videoConversionStatus: this.hasVideo ? "pending" : "skipped",
    });

    // No se espera esta promesa — la sesión ya se considera "finalizada" con los
    // webm originales a salvo; la conversión sigue en segundo plano y actualiza
    // el manifest cuando termina (éxito o fallo).
    this.scheduleConversions(muteManifest);

    return {
      sessionId: this.sessionId,
      tabId: this.tabId,
      folderName: this.meetingHandle.name,
      startedAt: this.startedAt,
      meetingTitle: this.meetingTitle,
      hasTranscript: this.hasCaption,
      hasVideo: this.hasVideo,
    };
  }

  async _writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 }) {
    const manifestHandle = await this.meetingHandle.getFileHandle("manifest.json", { create: true });
    const manifestWritable = await manifestHandle.createWritable();
    await manifestWritable.write(
      JSON.stringify(
        {
          startedAt: this.startedAt,
          meetingTitle: this.meetingTitle,
          hasTranscript: this.hasCaption,
          hasVideo: this.hasVideo,
          muteManifest,
          audioConversionStatus,
          videoConversionStatus,
          hasAudioMp3: hasAudioMp3 ?? false,
          hasVideoMp4: hasVideoMp4 ?? false,
        },
        null,
        2
      )
    );
    await manifestWritable.close();
  }

  async scheduleConversions(muteManifest) {
    let audioConversionStatus = this.streamsUsed.has("meeting") ? "pending" : "skipped";
    let videoConversionStatus = this.hasVideo ? "pending" : "skipped";
    let hasAudioMp3 = false;
    let hasVideoMp4 = false;

    if (this.streamsUsed.has("meeting")) {
      try {
        await this._convertStream({
          sourceFileName: STREAM_FILE_NAMES.meeting,
          targetFileName: "audio-reunion.mp3",
          inputExt: "webm",
          outputExt: "mp3",
          args: ["-vn"],
        });
        audioConversionStatus = "succeeded";
        hasAudioMp3 = true;
      } catch (error) {
        console.error("[Asterion] Falló la conversión de audio a MP3 (el webm original queda intacto):", error);
        audioConversionStatus = "failed";
      }
      await this._writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 });
    }

    if (this.hasVideo) {
      try {
        await this._convertStream({
          sourceFileName: STREAM_FILE_NAMES.video,
          targetFileName: "video-reunion.mp4",
          inputExt: "webm",
          outputExt: "mp4",
          args: [],
        });
        videoConversionStatus = "succeeded";
        hasVideoMp4 = true;
      } catch (error) {
        console.error("[Asterion] Falló la conversión de video a MP4 (el webm original queda intacto):", error);
        videoConversionStatus = "failed";
      }
      await this._writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 });
    }

    this.onConversionsFinished?.();
  }

  async _convertStream({ sourceFileName, targetFileName, inputExt, outputExt, args }) {
    const sourceHandle = await this.meetingHandle.getFileHandle(sourceFileName);
    const sourceFile = await sourceHandle.getFile();
    const inputBytes = new Uint8Array(await sourceFile.arrayBuffer());
    const outputBytes = await runFfmpegJob({ inputBytes, inputExt, outputExt, args });
    const targetHandle = await this.meetingHandle.getFileHandle(targetFileName, { create: true });
    const targetWritable = await targetHandle.createWritable();
    await targetWritable.write(outputBytes);
    await targetWritable.close();
  }
```

Agregar el import correspondiente: `import { runFfmpegJob } from "../offscreen/ffmpeg-client.js";`. Nunca se borra `audio-reunion.webm` ni `video-reunion.webm` en ningún punto de este flujo, pase lo que pase con la conversión.

- [ ] **Step 2: Modify `offscreen.js`** — no eliminar la sesión del `Map` hasta que `scheduleConversions()` termine

```js
// src/offscreen/offscreen.js (fragmento del handler de "asterion:session-ended")
} else if (message.type === "asterion:session-ended") {
  const writer = sessions.get(message.sessionId);
  if (writer) {
    const result = await writer.finalize({ muteManifest: message.muteManifest });
    chrome.runtime.sendMessage({ type: "asterion:session-finalized", ...result });
    // No se borra la entrada de `sessions` todavía: scheduleConversions() sigue
    // corriendo en segundo plano y necesita el meetingHandle de OPFS con vida.
    writer.onConversionsFinished = () => sessions.delete(message.sessionId);
  }
}
```

(Ajustar el nombre exacto de variables/estructura según el archivo real — el punto central es: la entrada del `Map` sobrevive hasta que termine la conversión, no solo hasta que termine `finalize()`.)

- [ ] **Step 3: Build + tests**

```bash
npm run build
npm test
```

- [ ] **Step 4: Manual verification** (no automatizable — requiere una reunión real de Meet)

Grabar unos minutos de audio+video en una reunión real, activar video, terminar la reunión. Confirmar en el historial que aparecen de inmediato `audio-reunion.webm`/`video-reunion.webm`/`transcripcion.txt`. Revisar la consola del offscreen document para ver el progreso logueado de la conversión, y confirmar que minutos después aparecen también `audio-reunion.mp3`/`video-reunion.mp4` en el historial (sin recargar código, `history.js` ya lista dinámicamente los archivos presentes en la carpeta). Descargar el mp3 y el mp4 y confirmar que se puede hacer seek/adelantar sin problema.

- [ ] **Step 5: Commit**

```bash
git add src/storage/session-writer.js src/offscreen/offscreen.js
git commit -m "feat: transcode audio to MP3 and video to MP4 with ffmpeg.wasm as a background job after finalize"
```

---

## Task 30: Tests unitarios de la cola de ffmpeg y del flujo de conversión

**Files:**
- Create: `src/offscreen/ffmpeg-client.test.js`
- Create: `src/storage/session-writer.test.js`

- [ ] **Step 1: Create `ffmpeg-client.test.js`** — verificar que la cola serializa los jobs (dos llamadas a `runFfmpegJob` no se solapan), mockeando `@ffmpeg/ffmpeg` para no cargar el wasm real

- [ ] **Step 2: Create `session-writer.test.js`** — mockear `ffmpeg-client` para verificar que `finalize()` resuelve sin esperar la conversión, que el orden es audio-luego-video, que un fallo en uno no interrumpe al otro, y que `manifest.json` queda con los campos correctos en cada combinación (éxito/fallo/sin video)

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: todos los tests en verde, incluyendo los 13 ya existentes.

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/ffmpeg-client.test.js src/storage/session-writer.test.js
git commit -m "test: cover the ffmpeg job queue and the finalize/conversion control flow"
```

---

## Task 31: Pantalla de configuración — preset de velocidad/calidad del video (MP4)

Nota post-implementación de Tasks 25-30: probando en real, la conversión de video con `-fps_mode vfr` (fix aplicado fuera de este plan, commit `ba31845`) sigue usando el preset por defecto de `libx264` (`medium`, sin especificar `-preset`). Para una reunión con mucho movimiento en pantalla esto puede tardar bastante (visto en pruebas: ~0.5x de velocidad respecto a la duración real del contenido cambiante). El usuario pidió hacer esto configurable: agregar una pantalla de "Configuración" (el ícono de engranaje del popup existe pero hoy es un SVG inerte, sin `id` ni listener — ver `src/popup/popup.js`, función `header()`) con un selector del preset de `libx264` a usar (`ultrafast`/`superfast`/`veryfast`/`faster`/`fast`/`medium`/`slow`/`slower`/`veryslow` — trade-off velocidad vs. compresión/calidad, por defecto `medium`, que es el mismo default que usa la librería si no se especifica `-preset`). El valor debe poder cambiarse **incluso durante una grabación en curso**, y la conversión debe usar el valor vigente **en el momento de ejecutarse** (no el que estaba al iniciar la grabación) — como la conversión ya corre como paso separado en segundo plano después de `finalize()` (Task 29), alcanza con leer `chrome.storage.local` justo antes de lanzar el job de ffmpeg, sin necesidad de pasar el valor por ningún mensaje de sesión.

**Files:**
- Create: `src/settings/settings.html`
- Create: `src/settings/settings.js`
- Modify: `src/popup/popup.js`
- Modify: `src/storage/session-writer.js`
- Modify: `manifest.json`

- [ ] **Step 1: Create `src/settings/settings.html`** — página standalone siguiendo exactamente el mismo patrón que `src/history/history.html` (su propio `<html>/<head>/<body>`, carga `../shared/theme.css`, header con botón "← Configuración" que hace `history.back()`/`window.close()` igual que el de historial). Contenido: un `<select>` (o grupo de botones tipo radio, lo que mejor encaje con el lenguaje visual ya definido en `theme.css`) con las 9 opciones de preset, y una etiqueta/descripción corta aclarando el trade-off ("Más rápido = menos calidad/compresión, más lento = mejor compresión").

- [ ] **Step 2: Create `src/settings/settings.js`** — al cargar, lee `chrome.storage.local.get({ videoPreset: "medium" })` y refleja el valor actual en el selector; al cambiar la selección, `chrome.storage.local.set({ videoPreset: <nuevo valor> })` inmediatamente (sin botón de "Guardar" — mismo espíritu que `autoStart` en el popup, que se guarda al toque). Seguir el patrón de imports/estructura de `src/history/history.js` (import de `icon` desde `../shared/icons.js` para el botón de volver, etc.).

- [ ] **Step 3: Modify `src/popup/popup.js`** — conectar el ícono de engranaje existente. En la función `header()`, envolver el ícono de settings en un elemento con `id="settings-link"` (por ejemplo un `<button>` sin estilo propio o un `<span>`, consistente con cómo está armado `history-link`), y agregar el listener (junto a donde ya se conecta `history-link`):

```js
document.getElementById("settings-link").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/settings/settings.html") });
});
```

- [ ] **Step 4: Modify `src/storage/session-writer.js`** — en `scheduleConversions()`, justo antes de la llamada a `_convertStream` del video, leer el preset vigente y agregarlo a los `args`:

```js
// dentro de scheduleConversions(), antes del bloque `if (this.hasVideo) { ... }`
const { videoPreset } = await chrome.storage.local.get({ videoPreset: "medium" });
```

y pasarlo en la llamada:

```js
await this._convertStream({
  sourceFileName: STREAM_FILE_NAMES.video,
  targetFileName: "video-reunion.mp4",
  inputExt: "webm",
  outputExt: "mp4",
  args: ["-fps_mode", "vfr", "-preset", videoPreset],
});
```

(`SessionWriter` corre dentro del offscreen document, que es una página de extensión con acceso completo a `chrome.storage` — no hace falta pasar el valor por ningún mensaje.)

- [ ] **Step 5: Modify `manifest.json`** — agregar `src/settings/settings.html` como página accesible; como se abre igual que `history.html` (vía `chrome.tabs.create` + `chrome.runtime.getURL`, no como recurso web accesible a otro origen), **no** hace falta tocar `web_accessible_resources` — confirmar que no se necesita ningún cambio de manifest más allá de que el archivo exista físicamente en el paquete de la extensión (Chrome sirve cualquier archivo del paquete en `chrome-extension://<id>/...` sin declaración extra, salvo que deba ser accedido desde un origen externo).

- [ ] **Step 6: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, 18/18 tests siguen pasando (no hay tests nuevos automatizados para esto — la UI y la lectura de `chrome.storage` en tiempo de conversión requieren verificación manual).

- [ ] **Step 7: Manual verification**

Abrir el popup, click en el engranaje, confirmar que abre la pantalla de configuración en una pestaña nueva con el preset actual (`medium` por defecto) seleccionado. Cambiarlo a `ultrafast`, iniciar una grabación con video, y **mientras graba** volver a configuración y cambiarlo a `veryslow`. Detener la grabación y confirmar en la consola del offscreen document (log `[Asterion ffmpeg:core]`) que el comando de ffmpeg para el video incluye `-preset veryslow` (el valor vigente al momento de la conversión, no el que estaba al iniciar). Confirmar también que con `ultrafast` la conversión es notablemente más rápida que con `medium`/`veryslow` (a costa de un archivo más pesado/con menos compresión).

- [ ] **Step 8: Commit**

```bash
git add src/settings/settings.html src/settings/settings.js src/popup/popup.js src/storage/session-writer.js
git commit -m "feat: add a settings screen to configure the video encode preset (speed vs. compression trade-off)"
```

---

## Task 32: Banner flotante arrastrable con snap al borde más cercano

El banner en la página de Meet (`src/content/meet-banner.js`) hoy vive fijo en `right: 16px; bottom: 16px` dentro de un Shadow DOM, sin forma de moverlo. El usuario pidió poder arrastrarlo a cualquier zona de la pantalla y que, al soltarlo, se pegue automáticamente al borde más cercano (arriba, abajo, izquierda o derecha — los 4 lados, confirmado con el usuario), y que esa posición elegida se recuerde entre reuniones/recargas.

**Files:**
- Modify: `src/content/meet-banner.js`
- Modify: `src/background/service-worker.js` (opcional, solo si se decide leer/escribir `bannerPosition` a través de un mensaje en vez de directo — ver Step 3)

- [ ] **Step 1: Hacer arrastrable el contenedor `#content`** — agregar listeners de `pointerdown`/`pointermove`/`pointerup` sobre `#content` (el `div` fijo dentro del shadow root, definido en `showBanner()`). Reglas importantes:
  - Ignorar el inicio del arrastre si el `pointerdown` ocurrió sobre un `button` (`event.target.closest("button")`), para no romper los clics de Iniciar/Detener/Expandir/Cerrar/Ver grabación.
  - Usar un umbral de movimiento (~5px) antes de considerarlo un arrastre real — si el pointer se suelta sin superar el umbral, no mover nada (para no romper clics normales en zonas no interactivas del banner, como el pill colapsado).
  - Durante el arrastre, seguir al cursor con `left`/`top` en píxeles (usar `setPointerCapture` para que el arrastre siga funcionando aunque el cursor salga del elemento), aplicando un cursor `grabbing`.

```js
// dentro de showBanner(), después de crear contentEl
let dragState = null;

contentEl.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) return;
  const rect = contentEl.getBoundingClientRect();
  dragState = {
    startX: event.clientX,
    startY: event.clientY,
    originLeft: rect.left,
    originTop: rect.top,
    moved: false,
  };
  contentEl.setPointerCapture(event.pointerId);
});

contentEl.addEventListener("pointermove", (event) => {
  if (!dragState) return;
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

contentEl.addEventListener("pointerup", (event) => {
  if (dragState?.moved) snapToNearestEdge();
  dragState = null;
  contentEl.style.cursor = "";
});
```

(Ajustá nombres/estructura real al archivo final — esto es una guía, no código para copiar textual si el resto del archivo sugiere algo distinto.)

- [ ] **Step 2: Implementar `snapToNearestEdge()`** — al soltar, calcular a qué borde del viewport está más cerca el centro (o el borde correspondiente) del elemento, y fijar la posición final con un margen de 16px en ese borde, dejando la coordenada perpendicular clampeada para que nunca quede fuera de la pantalla:

```js
const EDGE_MARGIN = 16;

function snapToNearestEdge() {
  const rect = contentEl.getBoundingClientRect();
  const distances = {
    top: rect.top,
    bottom: window.innerHeight - rect.bottom,
    left: rect.left,
    right: window.innerWidth - rect.right,
  };
  const edge = Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];

  contentEl.style.left = "auto";
  contentEl.style.right = "auto";
  contentEl.style.top = "auto";
  contentEl.style.bottom = "auto";

  if (edge === "left" || edge === "right") {
    const top = Math.min(Math.max(rect.top, EDGE_MARGIN), window.innerHeight - rect.height - EDGE_MARGIN);
    contentEl.style.top = `${top}px`;
    contentEl.style[edge] = `${EDGE_MARGIN}px`;
  } else {
    const left = Math.min(Math.max(rect.left, EDGE_MARGIN), window.innerWidth - rect.width - EDGE_MARGIN);
    contentEl.style.left = `${left}px`;
    contentEl.style[edge] = `${EDGE_MARGIN}px`;
  }

  savePosition({ edge, offset: edge === "left" || edge === "right" ? contentEl.style.top : contentEl.style.left });
}
```

- [ ] **Step 3: Persistir y restaurar la posición** — guardar `{ edge, offset }` en `chrome.storage.local` bajo una clave nueva, por ejemplo `bannerPosition` (seguir el mismo patrón plano que ya usa `autoStart`/`videoPreset`, sin objeto anidado si se prefiere serializar como string, o como objeto — usar criterio). Como `meet-banner.js` corre en el content script (ISOLATED world), que SÍ tiene acceso directo a `chrome.storage` (a diferencia del offscreen document — no aplica la limitación descubierta en un fix anterior), se puede leer/escribir directo con `chrome.storage.local.get/set`, sin necesidad de mensajería al service worker. Al llamar a `showBanner()`, antes de agregar `hostEl` al DOM, leer `bannerPosition` guardado y aplicar esa posición inicial en vez del `right: 16px; bottom: 16px` fijo (si no hay nada guardado, usar ese default de siempre).

- [ ] **Step 4: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, 18/18 tests siguen pasando (no hay tests automatizados de drag/DOM real de Meet — se verifica manualmente).

- [ ] **Step 5: Manual verification**

Entrar a una reunión, arrastrar el banner a distintas zonas de la pantalla (cerca de cada uno de los 4 bordes y también cerca del centro) y confirmar que siempre se pega al borde más cercano con un margen consistente, sin quedar nunca cortado fuera de la pantalla. Confirmar que los botones (Iniciar/Detener/Expandir/Cerrar/Ver grabación) siguen funcionando con un clic normal sin iniciar un arrastre accidental. Recargar la pestaña de Meet y confirmar que el banner aparece en la última posición donde quedó, no siempre en la esquina inferior derecha por defecto.

- [ ] **Step 6: Commit**

```bash
git add src/content/meet-banner.js
git commit -m "feat: make the in-page banner draggable with snap-to-nearest-edge and persisted position"
```

---

## Task 33: Badge de progreso en el ícono de la extensión mientras se convierte audio/video

Hoy, después de terminar una reunión, la conversión a MP3/MP4 sigue corriendo en segundo plano (Task 29) sin ninguna señal visible — el usuario tiene que entrar al historial y recargar la página repetidas veces para saber si ya terminó. El usuario pidió replicar lo que hace Fireflies: un badge numérico sobre el ícono de la extensión en la barra de herramientas mientras procesa, idealmente con un porcentaje de avance, y que el popup también refleje ese estado.

Diseño revisado y confirmado por Codex (no implementar nada distinto a esto sin volver a consultar):

- **El badge se pinta SIEMPRE desde el service worker** (`chrome.action.setBadgeText`/`setBadgeBackgroundColor`) — confirmado que `chrome.action`, igual que `chrome.storage`, no está disponible dentro del offscreen document (los offscreen documents solo garantizan `chrome.runtime`). El offscreen document manda mensajes, nunca pinta el badge directo.
- **El porcentaje se calcula con la duración real conocida de la grabación, no con el campo `progress` de ffmpeg.wasm** (confirmado con el código real de `@ffmpeg/ffmpeg` 0.12.15: ese campo es experimental y solo es preciso cuando la duración de entrada/salida coinciden — nuestros webm de `MediaRecorder` nunca declaran `Duration`, así que `progress` sale con valores sin sentido). Usar en cambio el campo `time` del evento (confirmado que viene en **microsegundos** de media ya procesada, revisando el código fuente instalado), dividido por la duración real de la grabación (`endedAt - startedAt`, capturada UNA SOLA VEZ al principio de `finalize()`, no con `Date.now()` recalculado en cada tick).
- **No inventar un porcentaje combinado de audio+video** — como corren secuencialmente y pesan muy distinto, mostrar el progreso de la fase actual tal cual: `A 42` mientras convierte audio, `V 12` mientras convierte video (cambiar de fase apenas termina audio, sin dejar "A 100" colgado insinuando que ya terminó todo).
- **El badge se limpia solo cuando NO queda ninguna conversión pendiente en absoluto**, no cuando termina una sesión individual — el offscreen document puede tener más de un `SessionWriter` corriendo conversiones en su cola global. El service worker debe mantener un `Map<sessionId, estado>` y limpiar el badge solo cuando el mapa queda vacío.
- **Si hay más de una reunión conviertiéndose a la vez, mostrar la cantidad de reuniones pendientes** (por ejemplo `"2"`) en vez de un porcentaje que mezclaría fases distintas de sesiones distintas — con exactamente una sesión pendiente, mostrar `A nn`/`V nn` como se describió arriba.
- El popup debe reflejar el mismo estado (no solo el badge) — como el popup ya hace polling cada 2 segundos (`refresh()` en `src/popup/popup.js`), lo más simple es agregar una consulta nueva al service worker en cada tick, en vez de armar un sistema de mensajes push separado.

**Files:**
- Modify: `src/offscreen/ffmpeg-client.js`
- Modify: `src/storage/session-writer.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/popup/popup.js`

- [ ] **Step 1: `ffmpeg-client.js` — callback de progreso por job.** Agregar un parámetro opcional `onProgress(timeMs)` a `runFfmpegJob({ inputBytes, inputExt, outputExt, args, onProgress })`. Dentro de `_runJob()`, justo antes de `ffmpeg.exec(...)`, registrar un listener de progreso ESCOPEADO A ESE JOB (no el listener global de diagnóstico que ya existe) vía `ffmpeg.on("progress", ({ time }) => onProgress?.(time / 1000))` (convertir de microsegundos a milisegundos), y sacarlo en el `finally` con `ffmpeg.off("progress", ese mismo handler)` (confirmar el nombre exacto del método `off` contra la API real instalada — Codex ya confirmó que existe). No tocar el listener de diagnóstico global que ya está en `getFfmpeg()`.

- [ ] **Step 2: `session-writer.js` — calcular el porcentaje y emitir mensajes de progreso.**
  - En `finalize()`, capturar `const endedAt = Date.now();` una sola vez, ANTES de disparar `scheduleConversions()`, y pasarlo a `scheduleConversions(muteManifest, endedAt)`.
  - En `scheduleConversions()`, calcular `const knownDurationMs = Math.max(1, endedAt - this.startedAt);` (evitar división por cero).
  - Antes de cada llamada a `_convertStream()` (audio y video), mandar `chrome.runtime.sendMessage({ type: "asterion:conversion-started", sessionId: this.sessionId, meetingTitle: this.meetingTitle, stream: "meeting"|"video" })` (envolver en try/catch silencioso, esto es solo una señal de UI, nunca debe poder romper la conversión real).
  - Pasarle a `_convertStream()` un `onProgress` que calcule `pct = Math.min(100, Math.max(0, Math.round((timeMs / knownDurationMs) * 100)))`, con throttling: solo mandar `chrome.runtime.sendMessage({ type: "asterion:conversion-progress", sessionId: this.sessionId, stream, pct })` cuando el `pct` entero cambió respecto al último mandado Y pasaron al menos 500ms desde el último mensaje (guardar `lastSentPct`/`lastSentAt` en variables locales del método). Ignorar valores de `timeMs` no finitos, negativos, o menores al último valor visto (protección ante posibles regresiones del contador de ffmpeg).
  - Al terminar cada stream (éxito o fallo) y al final del método completo (en el `finally` existente, junto a `onConversionsFinished`), mandar `chrome.runtime.sendMessage({ type: "asterion:conversion-finished", sessionId: this.sessionId })`.

- [ ] **Step 3: `service-worker.js` — mantener el estado y pintar el badge.**
  - Agregar un `const conversionStates = new Map();` a nivel de módulo (clave: `sessionId`, valor algo como `{ meetingTitle, stream, pct }`).
  - Listener para `asterion:conversion-started`: `conversionStates.set(sessionId, { meetingTitle, stream, pct: 0 })`, llamar a una función `updateBadge()`.
  - Listener para `asterion:conversion-progress`: actualizar la entrada existente (`stream`, `pct`) si existe, llamar a `updateBadge()`.
  - Listener para `asterion:conversion-finished`: `conversionStates.delete(sessionId)`, llamar a `updateBadge()`.
  - `updateBadge()`: si `conversionStates.size === 0`, `chrome.action.setBadgeText({ text: "" })`. Si `size === 1`, tomar la única entrada y pintar `chrome.action.setBadgeText({ text: `${stream === "video" ? "V" : "A"}${pct}` })` (confirmar que el texto entra bien en el badge — Chrome trunca badges largos, `A42`/`V12` debería entrar sin problema, verificar visualmente). Si `size > 1`, pintar `chrome.action.setBadgeText({ text: String(conversionStates.size) })`. Elegí un color de fondo razonable con `chrome.action.setBadgeBackgroundColor(...)` (por ejemplo un azul o el mismo acento que ya usa el diseño, ver `var(--accent-blue)`/`var(--accent-green)` en `src/shared/theme.css` para inspirarte, aunque acá es un valor hex fijo, no puede usar variables CSS).
  - Agregar un handler para un mensaje nuevo `asterion:get-conversion-status` que responda con un resumen del `conversionStates` actual (por ejemplo `{ count: conversionStates.size, entries: [...conversionStates.values()] }`), para que el popup lo pueda consultar.

- [ ] **Step 4: `popup.js` — reflejar el estado en el popup.** En `refresh()`, además de lo que ya hace, mandar `chrome.runtime.sendMessage({ type: "asterion:get-conversion-status" })` y renderizar una fila/tarjeta chica cuando `count > 0` (independiente del estado de la reunión actual — puede estar procesando una reunión anterior mientras el usuario ya está en una reunión nueva), con un texto simple tipo "Procesando audio... 42%" / "Procesando video... 12%" (si `count === 1`) o "Procesando 2 reuniones..." (si `count > 1`). Usar tu criterio de dónde encaja mejor esa fila en cada uno de los 4 estados del popup (`Listo`, `Reunión detectada`, `Grabando`, `Error`) — probablemente arriba del todo, debajo del header, ya que es información que no depende de en qué reunión está el usuario ahora mismo.

- [ ] **Step 5: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, 18/18 tests siguen pasando (no hay tests automatizados nuevos para esto — se verifica manualmente).

- [ ] **Step 6: Manual verification**

Grabar una reunión con video, terminarla, y confirmar: (a) apenas arranca la conversión de audio aparece el badge `A 0`/similar sobre el ícono de la extensión, avanzando; (b) al pasar a video cambia a `V 0` y sube; (c) el badge desaparece cuando termina todo; (d) abrir el popup mientras tanto y confirmar que muestra el mismo progreso; (e) si es posible, probar el caso de dos reuniones convirtiéndose a la vez (grabar una segunda reunión corta mientras la primera todavía está convirtiendo el video) y confirmar que el badge pasa a mostrar la cantidad de reuniones pendientes en vez de un porcentaje.

- [ ] **Step 7: Commit**

```bash
git add src/offscreen/ffmpeg-client.js src/storage/session-writer.js src/background/service-worker.js src/popup/popup.js
git commit -m "feat: show a toolbar badge and popup indicator with real conversion progress"
```

---

## Task 34: Persistir `endedAt`/duración por reunión (base para el rediseño del historial)

El usuario pidió rediseñar `src/history/history.html`/`history.js` para que coincida con un diseño hecho en Pencil (nodo `BwqWL` "Historial de reuniones", extraído completo con el MCP de Pencil — layout de 3 columnas: Sidebar con búsqueda/filtros/calendario/KPIs, Listado, Detalle con tabs Transcripción/Audio/Video/Manifest). Solo se implementa el **modo oscuro** (el modo claro del diseño tiene problemas de contraste, queda fuera de alcance). Antes de tocar la UI, hace falta un dato que hoy no se guarda en ningún lado: `endedAt`/duración de la reunión — se necesita para mostrar el rango horario real ("10:00 – 10:48") y para el KPI de "tiempo grabado este mes".

Codex confirmó (revisión previa) un detalle importante: `manifest.json` de cada reunión se reescribe VARIAS veces durante la conversión (`_writeManifest` se llama después de audio y después de video) — si `endedAt`/`durationMs` no se guardan como estado de instancia y se incluyen en TODAS esas reescrituras, se van a perder en la segunda escritura.

**Files:**
- Modify: `src/storage/session-writer.js`
- Modify: `src/background/service-worker.js`

- [ ] **Step 1: `session-writer.js`** — en `finalize()`, guardar `this.endedAt = Date.now();` como propiedad de instancia (en vez de la variable local `endedAt` que ya existe) y seguir usándola donde ya se usa (el cálculo de `knownDurationMs` en `scheduleConversions`). En `_writeManifest(...)`, agregar al objeto que se serializa: `endedAt: this.endedAt, durationMs: this.endedAt - this.startedAt`. En el objeto que retorna `finalize()` (el que se manda como `asterion:session-finalized`), agregar también `endedAt: this.endedAt, durationMs: this.endedAt - this.startedAt`.

- [ ] **Step 2: `service-worker.js`** — en `appendToHistory(meta)`, agregar `endedAt: meta.endedAt` y `durationMs: meta.durationMs` al objeto que se guarda en `chrome.storage.local.meetingHistory`.

- [ ] **Step 3: Build + tests**

```bash
npm run build
npm test
```

Expected: build limpio, 18/18 tests siguen pasando.

- [ ] **Step 4: Manual verification**

Grabar una reunión corta, terminarla, y confirmar (por ejemplo abriendo el `manifest.json` de esa reunión desde el historial actual, o inspeccionando `chrome.storage.local.meetingHistory` desde la consola del service worker) que `endedAt`/`durationMs` quedan guardados y sobreviven a la reescritura posterior del manifest cuando termina la conversión de audio/video.

- [ ] **Step 5: Commit**

```bash
git add src/storage/session-writer.js src/background/service-worker.js
git commit -m "feat: persist endedAt/duration per meeting for the redesigned history page"
```

---

## Task 35: Historial — layout de 3 columnas, sidebar funcional (búsqueda/filtros/calendario/KPIs), listado

Reescritura de `src/history/history.html`/`history.js` según el diseño de Pencil (nodo `BwqWL`, variantes `l08uG`/`bXi9t`/`PYNGS`/`mjX0I` para referencia de contenido — todas comparten el mismo Sidebar/Listado). Esta tarea cubre el layout general y las dos primeras columnas; el panel de Detalle es la Task 36.

**Diseño de referencia (extraído de Pencil, usar los mismos valores):**

- Página completa: 1440px de ancho, 3 columnas fijas: Sidebar 280px, Listado 520px, Detalle 640px (sin scroll horizontal — definir un modo angosto/responsive razonable en vez de heredar el `min-width: 360px` que tiene hoy `history.html`, ya que este layout es mucho más ancho).
- **Sidebar** (`fill: $bg`, `padding: 24`, `layout: vertical`, `gap: 20`):
  - Identificación: logo (usar el ícono real de la extensión, `icons/icon32.png`, mismo criterio que en el popup/banner) + "Asterion" (15px, weight 600), título "Historial" (20px, weight 600), descripción "Reuniones guardadas localmente en este dispositivo." (12px, `$text-muted`).
  - Buscador: input de texto sobre `$bg-elevated`, ícono de lupa, placeholder "Buscar por título" — filtra la lista por substring del título (case-insensitive).
  - Filtros: label "Filtros" (11px, weight 600, `$text-muted`) + 5 chips combinables en 3 filas: "Todas" / "Con transcripción" (fila 1), "Con video" / "Solo audio" (fila 2), "Este mes" / "Este año" (fila 3). Chip activo: `fill: $bg-button`; inactivo: `fill: $bg`. "Todas" desactiva cualquier otro filtro de tipo de archivo. "Con transcripción"/"Con video"/"Solo audio" son mutuamente combinables entre sí pero conceptualmente: `hasTranscript`, `hasVideo`, `!hasVideo` respectivamente (no hace falta un campo `hasAudio` nuevo — el audio siempre se graba, así que "Solo audio" es simplemente `!hasVideo`, confirmado con Codex). "Este mes"/"Este año" filtran por `startedAt` en la zona horaria local del usuario.
  - Calendario: mes/año actual con navegación ←/→, grilla de 7 columnas (Lu-Do) x hasta 6 filas, cada día es un componente con el número y un punto azul (`$accent-blue`) si hay al menos una reunión ese día (comparar por fecha local, no por timestamp crudo). Click en un día filtra el listado a esa fecha específica (toggle: click de nuevo lo deselecciona). Día seleccionado: `fill: $accent-blue`.
  - KPIs: 4 filas "valor grande (16px) + etiqueta (12px, `$text-muted`)": "N reuniones este mes", "Nh Nm de grabación" (sumar `durationMs` de las reuniones de este mes, Task 34), "N reuniones con video", "N reuniones con transcripción" — todos calculados en el momento, síncronos, contra el array completo de `meetingHistory` (hasta 200 elementos, trivial para JS síncrono, confirmado con Codex — no hace falta memoización).
- **Listado** (`padding: 20`, `layout: vertical`, `gap: 4`):
  - Header: "Reuniones" (20px, weight 600) + "N resultados" (13px, `$text-secondary`, refleja el filtro activo) + selector de orden a la derecha ("Más recientes primero" / "Más antiguas primero", sobre `$bg-elevated`).
  - Lista de tarjetas (`fill: $bg-elevated`, `radius: 12`, `padding` interno, `gap: 8` entre tarjetas): título (14px) + ícono "more" a la derecha, fecha+hora ("Jue, 17 de septiembre de 2026 · 10:00 – 10:48", 12px `$text-muted` — usar `durationMs`/`endedAt` reales de la Task 34), fila de chips chicos por archivo disponible (Transcripción/Audio/Video/Manifest — mostrar solo los que existen realmente para esa reunión), link "Ver detalles" (`$accent-blue`) que selecciona esa reunión para el panel de Detalle (Task 36).
  - La lista completa (filtrada/ordenada/buscada) se recalcula de forma pura a partir del estado (ver arquitectura de estado abajo) — nunca dispara I/O de OPFS para renderizar las tarjetas, todos los datos vienen de `chrome.storage.local.meetingHistory` (confirmado con Codex: el problema de rendimiento actual es que `renderMeetingFiles` dispara una enumeración de OPFS por tarjeta; el rediseño NO debe hacer eso para el listado, solo para el panel de Detalle cuando se abre una reunión específica).

**Arquitectura de estado (confirmada con Codex, aplica a toda la página incluyendo la Task 36):**
- Un objeto de estado único a nivel de módulo: `{ meetings, search, filters: { transcript, video, audioOnly, thisMonth, thisYear }, calendarMonth, selectedDay, sort, selectedMeetingId, selectedTab }`.
- Una función pura `deriveVisibleMeetings(state)` que aplica búsqueda + filtros + día seleccionado + orden sobre `state.meetings`, sin efectos secundarios.
- Funciones de render separadas para sidebar/listado/detalle (la de detalle es la Task 36), cada una re-renderizando su propia porción del DOM cuando cambia el estado relevante — evitar volver a montar el reproductor de audio/video activo en cada tecla tipeada en el buscador (eso rompería la reproducción en curso).
- Usar `textContent`/escape explícito para título de reunión y cualquier texto que pueda contener HTML — nunca interpolar directo en `innerHTML` sin escapar (aplica sobre todo al contenido real de transcripción/manifest en la Task 36, pero establecé el patrón acá también).
- Escuchar `chrome.storage.onChanged` para refrescar la lista si el historial cambia mientras la página está abierta (por ejemplo, una conversión que termina en segundo plano y actualiza algo, o una reunión nueva que se agrega) — confirmado con Codex como un gap real de la página actual.

**Files:**
- Rewrite: `src/history/history.html`
- Rewrite: `src/history/history.js`

- [ ] **Step 1-N**: implementar lo descrito arriba. Dividí el trabajo en los pasos que consideres más claros (estructura HTML/CSS del layout de 3 columnas primero, después el estado y el sidebar, después el listado) — no hace falta que sea un solo paso gigante, agregá tantos `- [ ] **Step N**` como haga falta para que quede prolijo, siguiendo el mismo estilo que el resto del plan.
- [ ] **Build + tests**: `npm run build && npm test` — build limpio, 18/18 tests siguen pasando (no hay tests automatizados nuevos para esto).
- [ ] **Manual verification**: abrir el historial con varias reuniones reales grabadas, probar buscar por texto, cada chip de filtro individualmente y combinados, navegar el calendario y hacer click en un día con/sin reuniones, cambiar el orden, y confirmar que los KPIs coinciden con la realidad.
- [ ] **Commit**: `git add src/history/history.html src/history/history.js` + mensaje descriptivo.

---

## Task 36: Historial — panel de Detalle (tabs, transcripción real, manifest real, eliminar)

Continúa la Task 35 — el panel de Detalle (640px) que se abre al seleccionar una reunión del listado.

**Diseño de referencia:**

- Header (`padding: 24`): título de la reunión (18px, weight 600), fecha completa ("Jueves, 17 de septiembre de 2026", 13px `$text-secondary`), fila de metadata: rango horario real (`startedAt`–`endedAt` de la Task 34, 12px `$text-muted`) + punto separador + fuente ("Google Meet" — **Codex marcó que este campo no tiene respaldo de datos real hoy**; usar un texto fijo "Google Meet" ya que la extensión solo captura de ahí, no hace falta un campo nuevo).
- File tabs (4): Transcripción / Audio / Video / Manifest — mostrar SOLO los tabs de contenido que realmente existen para esa reunión (por ejemplo, sin transcripción, no mostrar ese tab; sin video, no mostrar el tab de Video). Tab activo: `fill: $bg-button`.
- Contenido por tab (cargar el archivo real de OPFS recién cuando se abre esa reunión/tab, no antes — confirmado con Codex, evitar I/O innecesario):
  - **Transcripción**: leer `transcripcion.txt` real, parsear líneas `[mm:ss] [speaker] texto` y renderizar una fila por línea: timestamp (`$text-muted`, monoespaciado opcional) + nombre del hablante en negrita (`$text-primary`) + el texto (`$text-secondary`) — confirmado con el usuario, sin inventar secciones H1/Agenda/Notas como en el mockup del diseño.
  - **Manifest**: leer `manifest.json` real de esa reunión, mostrarlo con `JSON.stringify(obj, null, 2)` resaltado con una función chica propia (tokenizar por regex: claves, strings, números, booleanos/`null`, cada uno con su color) — **IMPORTANTE, confirmado con Codex**: escapar `&`, `<`, `>` del texto ANTES de envolver los tokens en `<span>`, porque `meetingTitle` (que sí puede terminar en el manifest) viene de `document.title` de la pestaña de Meet — no es un dato 100% controlado por la extensión, así que insertarlo crudo vía `innerHTML` es un riesgo real de XSS dentro de una página de la extensión, no algo teórico.
  - Audio/Video: placeholder en esta tarea (la Task 37 implementa los reproductores custom) — dejar el contenedor listo con un mensaje simple tipo "Cargando..." si hace falta, sin bloquear el resto de esta tarea.
- Footer: nombre + peso del archivo del tab activo (usar `file.size` del archivo real leído de OPFS), botones "Abrir" (reusar la lógica de `viewFile` del `history.js` actual) y "Descargar" (reusar `downloadFile`), separador, link "Eliminar reunión" (`$accent-red`) que abre el diálogo de confirmación.
- **Diálogo de eliminar**: reemplazar el `confirm()` nativo que usa `deleteMeeting()` hoy por un modal real (`fill: $bg-elevated`, `radius: 16`) con título "Eliminar reunión", cuerpo "Se eliminarán {título} y todos sus archivos de este dispositivo. Esta acción es permanente y no se puede deshacer.", botones Cancelar/Eliminar (`$accent-red`). Confirmado con Codex: el modal necesita manejar foco correctamente (atrapar el foco adentro, cerrar con Escape, devolver el foco al elemento que abrió el modal al cerrar) — no hace falta una librería, son unos pocos listeners.

**Files:**
- Modify: `src/history/history.js` (continúa sobre la Task 35, mismo archivo)
- Modify: `src/history/history.html` (si hace falta CSS nuevo para el detalle/modal)

- [ ] **Step 1-N**: implementar lo descrito arriba, tantos steps como haga falta.
- [ ] **Build + tests**: `npm run build && npm test`.
- [ ] **Manual verification**: abrir el detalle de varias reuniones distintas (con y sin transcripción/video), confirmar que los tabs que no aplican no aparecen, que la transcripción real se ve bien, que el manifest real se ve resaltado y sin romperse aunque el título de la reunión tenga caracteres raros (probar con una reunión cuyo título tenga `<`/`>`/`&` si es posible, para confirmar el escape), y que Eliminar reunión funciona con el modal nuevo.
- [ ] **Commit**.

---

## Task 37: Historial — reproductores custom de audio y video

Implementa los tabs de Audio y Video del panel de Detalle (Task 36), con controles propios en vez de los nativos del navegador — coincidiendo con el diseño de Pencil (componentes `C · Audio player` y `C · Video player`).

**Diseño de referencia:**

- **Audio**: label "Audio de la reunión" arriba. Fila de "fuentes" (decorativa en el diseño, no hace falta que sea funcional — es un solo archivo de audio ya mezclado, no hay selección real de fuente). Transporte: retroceder 10s, play/pausa (círculo `$accent-blue`, 52px), adelantar 10s, tiempo actual/total ("12:04 / 48:12"). Barra de progreso arrastrable (`$bg-button` de fondo, `$accent-blue` la porción reproducida). Control de volumen (ícono + barra).
- **Video**: reproductor con esquinas redondeadas (`radius: 12`, fondo `#0E1016`), controles superpuestos abajo con fondo semitransparente (`#00000080`): play/pausa, barra de seek, tiempo, volumen, pantalla completa — todos con íconos blancos sobre el video.
- Ambos: usar un `<audio>`/`<video>` nativo oculto (`controls: false`) manejado manualmente vía su API (`play()`, `pause()`, `currentTime`, `volume`, eventos `loadedmetadata`/`timeupdate`/`durationchange`/`ended`/`error`) — confirmado con Codex.
- Resolver qué archivo reproducir con fallback: `audio-reunion.mp3` si existe, si no `audio-reunion.webm` (ídem `video-reunion.mp4` → `video-reunion.webm`) — la conversión a mp3/mp4 puede no haber terminado todavía (el manifest puede estar en `audioConversionStatus: "pending"` cuando el usuario abre el historial justo después de terminar una reunión).
- **Importante (confirmado con Codex)**: NO intentar autoplay al abrir el tab (Chrome puede bloquear reproducción sin gesto del usuario) — el usuario hace click en play manualmente. Revocar el blob URL del reproductor anterior recién cuando se reemplaza/cierra, nunca mientras sigue reproduciéndose (por ejemplo, al cambiar de reunión seleccionada en el listado mientras el audio de la anterior sigue sonando — decidir con criterio si eso debe pausar/detener la reproducción anterior primero).

**Files:**
- Modify: `src/history/history.js`

- [ ] **Step 1-N**: implementar lo descrito arriba.
- [ ] **Build + tests**: `npm run build && npm test`.
- [ ] **Manual verification**: reproducir audio y video real de una reunión grabada, probar play/pausa, arrastrar la barra de progreso, retroceder/adelantar 10s, cambiar volumen, pantalla completa del video, y confirmar que cambiar de reunión seleccionada no deja audio/video sonando de fondo sin control ni rompe la página.
- [ ] **Commit**.

---

## Task 38: Historial — Detalle: contenedor con fondo, tabs con ícono y footer de acciones como en el diseño

El panel de Detalle (Task 36/37) ya es funcional pero visualmente se aleja del diseño de Pencil (nodo `QcJgR`). Ajustar solo estilo/estructura, sin tocar la lógica de lectura de archivos ni de reproducción ya implementada.

**Diseño de referencia (extraído del nodo `QcJgR` vía MCP de Pencil):**

- Panel (`#detail-panel`): `fill: $bg-elevated`, borde solo a la izquierda (`stroke: $border`, `strokeWidth: {left: 1}`), `padding: 24`, layout vertical `gap: 16`. (El `padding: 24` y el borde izquierdo ya deberían existir o ser triviales de ajustar; verificar contra el `.detail-panel`/`.history-app` actual.)
- **Tabs de archivo** (componente `C · File tab`): cada tab es `cornerRadius: 8`, `gap: 6`, `padding: [8, 12]` (8 vertical, 12 horizontal), con **ícono (14x14) + label (12px, weight 500)** — hoy `.detail-tab` en `history.js`/`history.html` sólo renderiza texto, sin ícono. Agregar el ícono correspondiente a cada tab, mismos nombres que ya se usan en los file chips del listado: `file-text` (Transcripción), `volume-2` (Audio), `video` (Video), `braces` (Manifest). Tab activo: `fill: $bg-button`, ícono y texto en `$text-primary`. Tab inactivo: sin fondo (transparente), ícono y texto en `$text-secondary`. No hay `font-weight: 600` extra en el activo en el diseño — el peso del label es 500 en ambos estados, solo cambia el color y el fondo.
- **Contenedor del contenido del tab** (frames "Transcript/Audio/Video/Manifest viewer" en el diseño): el contenido de cada tab (lista de transcripción, reproductor, JSON del manifest) debe ir envuelto en un contenedor propio con `fill: $bg` (un tono más oscuro que el panel `$bg-elevated` — esto le da el "color de fondo específico" que pidió el usuario), `cornerRadius: 12`, `padding: 20`, ocupando el ancho/alto disponible. Hoy `.detail-tab-content` no tiene fondo ni padding propio — el contenido flota directamente sobre el fondo del panel. El manifest ya tiene su propio `<pre class="manifest-code">` con fondo/borde propios (`#151820`, `border: 1px solid var(--border)`) — decidir con criterio si ese `<pre>` debe perder su fondo/borde individual ahora que vive dentro del contenedor nuevo (para no duplicar "caja dentro de caja"), o si alcanza con que el contenedor nuevo styling reemplace ambos. Mismo criterio para `.transcript-list` y `.custom-media-player`, que hoy no tienen contenedor propio.
- **Footer** (frame "Detail footer", `gap: 12`, sin borde superior — hoy `.detail-footer` tiene `border-top: 1px solid var(--border)`, en el diseño la línea divisoria está SOLO entre las acciones de archivo y "Eliminar reunión", no arriba de todo el footer):
  - **Fila de archivo** (`justifyContent: space_between`, `alignItems: center`):
    - Izquierda: nombre del archivo (12px, weight 500, `$text-secondary`) y tamaño (11px, `$text-muted`) apilados verticalmente (`gap: 2`) — hoy están concatenados en un solo `<span>` con "·". Separarlos en dos líneas.
    - Derecha (`gap: 8`, `alignItems: center`): dos botones con chrome real (hoy son links de texto plano `color: var(--accent-blue)` sin fondo/borde):
      - **"Abrir"**: `cornerRadius: 8`, `stroke: $border` (`strokeWidth: 1`), `padding: [7, 10]`, ícono `external-link` (12x12, `$text-secondary`) + label (12px, weight 500, `$text-secondary`).
      - **"Descargar"**: `fill: $bg-button`, `cornerRadius: 8`, `padding: [7, 10]`, ícono `download` (12x12, `$text-primary`) + label (12px, weight 500, `$text-primary`).
      - Ambos íconos (`external-link`, `download`) no existen todavía en `src/shared/icons.js` — agregarlos con el mismo patrón que los íconos existentes (paths reales de `node_modules/lucide-static/icons/`, nunca dibujados a mano).
  - **Línea divisoria**: rectángulo de 1px de alto, `fill: $border`, ancho completo — entre la fila de archivo y la fila de eliminar (reemplaza el actual `.detail-footer-separator` vertical de 14px que separa "Descargar" de "Eliminar reunión" en la misma fila).
  - **Fila "Eliminar reunión"**: propia fila debajo de la línea divisoria (no más inline con Abrir/Descargar), `gap: 8`, `alignItems: center`, ícono `trash-2` (14x14, `$accent-red`) + label "Eliminar reunión" (12px, weight 500, `$accent-red`). Reusar el modal de confirmación ya implementado en la Task 36 (`showDeleteDialog`), sin cambios de lógica.
- Mantener sin cambios: la lógica de `readActiveFile`, `renderTabContent`, `createMediaPlayer`, `parseTranscript`, `highlightJson`/`escapeHtml`, `availableTabs`, y el manejo de foco/Escape del modal de eliminar — esta tarea es puramente de estilo/estructura del markup, no de comportamiento.

**Files:**
- Modify: `src/history/history.js` (estructura del tablist con íconos, wrapper del contenido del tab, estructura del footer en dos filas)
- Modify: `src/history/history.html` (CSS: `.detail-tab` con ícono, nuevo contenedor de contenido del tab con `fill`/`radius`/`padding`, rediseño de `.detail-footer`/`.detail-file-meta`/`.detail-file-actions`/`.detail-action`/`.delete-meeting-button`)
- Modify: `src/shared/icons.js` (agregar íconos `external-link` y `download`)

- [ ] **Step 1-N**: implementar lo descrito arriba, tantos steps como haga falta.
- [ ] **Build + tests**: `npm run build && npm test`.
- [ ] **Manual verification**: abrir el detalle de una reunión con transcripción, audio, video y manifest; confirmar que cada tab muestra su ícono correspondiente y que el tab activo tiene el fondo `$bg-button`; confirmar que el contenido de cada tab (transcripción, reproductores, JSON) se ve dentro de un contenedor con fondo propio, no flotando sobre el fondo del panel; confirmar que el footer muestra nombre/tamaño del archivo apilados, los botones "Abrir"/"Descargar" con el chrome nuevo (borde vs. fondo), la línea divisoria, y la fila "Eliminar reunión" debajo funcionando igual que antes (modal con foco atrapado, Escape, restauración de foco).
- [ ] **Commit**.
