# Asterion — Captura Automática (v2, post-tabCapture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensión de Chrome MV3 que, para una reunión de Google Meet, captura automáticamente (sin clic) audio de la reunión, audio propio y transcripción interceptando el WebRTC interno de Meet, ofrece video como función aparte con consentimiento explícito, y guarda todo localmente.

**Reemplaza a:** [2026-09-13-meet-capture-prototype.md](2026-09-13-meet-capture-prototype.md), cuyas Tasks 9-13 (basadas en `chrome.tabCapture` + offscreen document) quedaron obsoletas al descubrir que esa API no permite auto-inicio. Las Tasks 1-3 y 5.5-8 de ese plan (scaffolding, lógica pura, banner/observadores de DOM) se reutilizan aquí con ajustes menores (sin pausa).

**Arquitectura:** Content script `MAIN world` (`document_start`) que parchea `RTCPeerConnection`/`getUserMedia` para interceptar audio de Meet y graba con `MediaRecorder`; content script `ISOLATED world` para detección/banner/DOM, puenteando al `MAIN world` vía `postMessage` y al service worker vía `chrome.runtime`; service worker como control plane sin media; popup como superficie de estado/transcripción/config.

**Tech Stack:** JavaScript vanilla, Manifest V3 (content script `world: "MAIN"`), Web Audio API, MediaRecorder, File System Access API, Vitest.

**PRD de referencia:** [asterion-alcance.md](../../../asterion-alcance.md).

---

## Task 1: Project scaffolding

Idéntico al Task 1 + Task 1.5 del plan viejo (reutilizado sin cambios: no dependían de `tabCapture` ni de pausa).

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

## Task 2: Mute-interval manifest logic

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

## Task 3: Caption parser logic

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

## Task 4: Arquitectura de storage cross-origin (decisión, no código)

**Bloqueante para las Tasks de manifest/storage posteriores.** Ver discusión en el plan de arranque de esta sesión. Pendiente de consulta a Codex — no escribir código de storage hasta resolver esto.

---

*(Tasks 5+ se agregan a medida que se resuelven y se ejecutan, siguiendo el ciclo definido en el plan de arranque de esta sesión.)*
