# Mic replaceTrack Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-specific override:** in this repo, tasks are delegated to and executed by the `codex:codex-rescue` agent (Codex), not by generic Claude subagents — see `CLAUDE.md`. Claude reviews each task's result against this plan before moving to the next one.

**Goal:** Investigate and take a first pass at a reported bug where, after the echo fix shipped in `docs/superpowers/plans/2026-09-21-audio-mixer-global-stream-keying.md`, the user's own recorded voice is noticeably quieter than in Fireflies under the same conditions (same meeting, same time, A/B tested) — by making Asterion track whichever audio track Google Meet is *actually* sending at any given moment (via `RTCRtpSender.replaceTrack`), instead of permanently trusting the one `getUserMedia()` first returned.

**Architecture:** Add a global `RTCRtpSender.prototype.replaceTrack` patch (the same technique a decompiled Fireflies build uses) that reports every local track replacement, and a `getCurrentLocalAudioTrack()` helper that inspects every active patched `RTCPeerConnection`'s senders to find whichever audio track is presently attached. Wire both into `bootstrap.js`: resolve the *current* sender track (not the stale `getUserMedia`-captured one) when a recording session starts, and live-update the mixer's mic source if Meet swaps the track while a recording is already in progress.

**Tech Stack:** Same as the rest of this investigation — vanilla JS WebRTC/Web Audio APIs, Vitest with hand-written fakes.

**Context — how we got here, and how confident this fix actually is:** This is the fifth plan in an ongoing audio-quality investigation this session. The previous plan (`2026-09-21-audio-mixer-global-stream-keying.md`, shipped) fixed a confirmed echo. With that fixed, the user ran the same kind of controlled A/B test again (same meeting, same time, both extensions recording) and found their own mic is audibly quieter with Asterion than with Fireflies, while remote participants sound fine in both.

Investigating why: `rtc-patch.js`'s `installGetUserMediaPatch` captures the mic track once, the first time Google Meet calls `getUserMedia()`, and that same track object is used for the entire recording (`micTrack` is a module-level variable in `bootstrap.js`, set once, never updated). Re-inspecting the decompiled Fireflies bundle (from earlier in this investigation) confirmed something not fully appreciated before: Fireflies does **not** capture the local mic via `getUserMedia` interception at all — it captures it by watching the *outgoing* WebRTC path (`RTCRtpSender`/`addTrack`), and specifically monkey-patches `window.RTCRtpSender.prototype.replaceTrack` to detect when that outgoing track changes later (logged in their code as `"LOCAL_TRACK_REPLACED"`).

**The hypothesis (Codex-reviewed twice, rated plausible but explicitly unconfirmed):** if Google Meet ever calls `sender.replaceTrack(...)` on the outgoing mic sender after the initial `getUserMedia()` — for example to swap in a track that's been through Meet's own internal audio processing — Asterion's current code would never notice and would keep mixing the original, possibly quieter, raw track for the whole session, while Fireflies (which explicitly watches for this) would pick up whatever Meet is actually sending. Codex's independent assessment: the mechanism is plausible and grounded in real API usage (`replaceTrack` is precisely the API for this), but there is no independent confirmation that Meet specifically swaps in a *louder/processed* track — it's equally possible Fireflies built that interception for an unrelated reason (device switching, reconnection recovery) that wouldn't explain this symptom at all. Codex also flagged, and this plan takes seriously, that a `GainNode` at unity gain and the `channelCountMode: "explicit"` hardening from an earlier plan are both very unlikely culprits per the Web Audio spec — not worth re-litigating without new evidence.

Given that, this plan follows the same pattern as the rest of this investigation: implement the fix the evidence points to (tracking the sender's actual current track, live), **and** add enough diagnostic logging that if this *doesn't* fully resolve the quiet-mic symptom, the next reproduction gives real proof of what's actually happening (was `replaceTrack` ever called at all? with what before/after track ids? did the patch even install before Meet's own code ran?) instead of another round of hypothesis-guessing.

**A caveat this plan cannot fully close (flagged by Codex):** if Google Meet's own code cached a reference to the *unpatched* `RTCRtpSender.prototype.replaceTrack` before this extension's content script installed the patch, any replacement Meet makes through that cached reference would be invisible to us — "no `sender-replace-track` logs observed" would then mean "we couldn't see it happen," not "it didn't happen." In practice this content script runs at `document_start` (before Meet's own page scripts execute), which makes an early cache unlikely, but it's not provable from here — Task 3's manual verification treats "no logs at all, including no install confirmation" as inconclusive rather than a clean disconfirmation.

---

## File Structure

- Modify: `src/webrtc-bootstrap/rtc-patch.js` — track active (non-closed) patched connections; add `getCurrentLocalAudioTrack()` to resolve the live outgoing audio track from those connections' senders (picking a `"connected"` candidate over a merely-not-yet-closed one when there's a choice, and logging every candidate considered); add `installReplaceTrackPatch()` to detect and report `RTCRtpSender.replaceTrack` calls for audio senders, firing its callback only once the replacement actually succeeds.
- Modify: `src/webrtc-bootstrap/rtc-patch.test.js` — extend the shared `FakePeerConnection` test fake with sender support; add tests for both new exports, including the edge cases from Codex's review (closed-connection guard tested independently of the active-set cleanup, a rejected `replaceTrack` not firing the callback, idempotent double-install).
- Modify: `src/webrtc-bootstrap/bootstrap.js` — install the new patch; prefer `getCurrentLocalAudioTrack()` over the `getUserMedia`-captured track when a session starts; track mute state explicitly (instead of inferring it from the mixer's internal gain value) so a mid-session track swap preserves it correctly; live-update the mixer's mic source on a mid-session track replacement, explicitly logging (and not crashing on) the `replaceTrack(null)` case.

---

### Task 1: Track active connections and expose the current local audio track + replaceTrack detection

**Files:**
- Modify: `src/webrtc-bootstrap/rtc-patch.js`
- Modify: `src/webrtc-bootstrap/rtc-patch.test.js`

- [ ] **Step 1: Extend the shared test fake with sender support**

`FakePeerConnection` (already in `src/webrtc-bootstrap/rtc-patch.test.js`, shared by every test in the file) needs a `getSenders()` method for the new `getCurrentLocalAudioTrack()` tests. Change:

```js
class FakePeerConnection {
  constructor() {
    this.connectionState = "new";
    this._listeners = {};
  }
  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }
  _emit(type, eventLike) {
    (this._listeners[type] || []).forEach((handler) => handler(eventLike));
  }
  _setConnectionState(state) {
    this.connectionState = state;
    this._emit("connectionstatechange");
  }
}
```

to:

```js
class FakePeerConnection {
  constructor() {
    this.connectionState = "new";
    this._listeners = {};
    this._senders = [];
  }
  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }
  _emit(type, eventLike) {
    (this._listeners[type] || []).forEach((handler) => handler(eventLike));
  }
  _setConnectionState(state) {
    this.connectionState = state;
    this._emit("connectionstatechange");
  }
  getSenders() {
    return this._senders;
  }
  _setSenders(senders) {
    this._senders = senders;
  }
}
```

- [ ] **Step 2: Write the failing tests**

Add these `describe` blocks anywhere after the existing ones in `src/webrtc-bootstrap/rtc-patch.test.js` (e.g. at the end of the file):

```js
describe("getCurrentLocalAudioTrack", () => {
  it("returns null when there are no active connections", async () => {
    vi.resetModules();
    const { getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    expect(getCurrentLocalAudioTrack()).toBeNull();
  });

  it("returns the current audio sender's track from an active connection", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    const audioTrack = fakeAudioTrack("mic-1");
    pc._setSenders([{ track: { kind: "video", id: "v1" } }, { track: audioTrack }]);

    expect(getCurrentLocalAudioTrack()).toBe(audioTrack);
  });

  it("prefers a candidate from a connection whose connectionState is 'connected' over one that is merely not closed", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const staleConnectionTrack = fakeAudioTrack("stale");
    const activeConnectionTrack = fakeAudioTrack("active");
    const stalePc = new window.RTCPeerConnection();
    stalePc._setSenders([{ track: staleConnectionTrack }]);
    stalePc._setConnectionState("disconnected");
    const activePc = new window.RTCPeerConnection();
    activePc._setSenders([{ track: activeConnectionTrack }]);
    activePc._setConnectionState("connected");

    expect(getCurrentLocalAudioTrack()).toBe(activeConnectionTrack);
  });

  it("skips a connection whose connectionState is closed/failed even if it's still in the active set", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc._setSenders([{ track: fakeAudioTrack("mic-1") }]);
    // Mutated directly (not via _setConnectionState, which would also fire our
    // own "connectionstatechange" listener and remove this pc from
    // activeConnections) — this exercises getCurrentLocalAudioTrack's own
    // internal closed/failed guard specifically, independent of that cleanup,
    // per Codex's review: the original version of this test only exercised the
    // Set-removal side effect, never the guard itself.
    pc.connectionState = "closed";

    expect(getCurrentLocalAudioTrack()).toBeNull();
  });

  it("logs every candidate it considered (not just the one it picked)", async () => {
    vi.resetModules();
    const { installRtcPatch, getCurrentLocalAudioTrack } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    const disconnectedTrack = fakeAudioTrack("disconnected-mic");
    const connectedTrack = fakeAudioTrack("connected-mic");
    const disconnectedPc = new window.RTCPeerConnection();
    disconnectedPc._setSenders([{ track: disconnectedTrack }]);
    disconnectedPc._setConnectionState("disconnected");
    const connectedPc = new window.RTCPeerConnection();
    connectedPc._setSenders([{ track: connectedTrack }]);
    connectedPc._setConnectionState("connected");
    const logs = [];

    getCurrentLocalAudioTrack({ log: (event, details) => logs.push({ event, details }) });

    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe("current-local-audio-track-lookup");
    expect(logs[0].details.candidateCount).toBe(2);
    expect(logs[0].details.candidates.map((c) => c.trackId).sort()).toEqual(["connected-mic", "disconnected-mic"]);
    expect(logs[0].details.selectedTrackId).toBe("connected-mic");
  });
});

describe("installReplaceTrackPatch", () => {
  let originalRTCRtpSender;

  beforeEach(() => {
    originalRTCRtpSender = window.RTCRtpSender;
    window.RTCRtpSender = class {
      constructor(track) {
        this.track = track;
      }
      async replaceTrack(newTrack) {
        this.track = newTrack;
        // Valor centinela devuelto a propósito, para poder comprobar que
        // installReplaceTrackPatch preserva lo que el replaceTrack original
        // resolvió (el contrato real de RTCRtpSender.replaceTrack()), en vez
        // de perderlo o devolver undefined siempre.
        return "replace-track-resolved-value";
      }
    };
  });

  afterEach(() => {
    window.RTCRtpSender = originalRTCRtpSender;
  });

  it("calls onAudioTrackReplaced (after the replacement resolves) and logs the attempt", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    const onAudioTrackReplaced = vi.fn();
    const logs = [];
    installReplaceTrackPatch({ onAudioTrackReplaced, log: (event, details) => logs.push({ event, details }) });

    const oldTrack = fakeAudioTrack("old");
    const newTrack = fakeAudioTrack("new");
    const sender = new window.RTCRtpSender(oldTrack);

    const resolvedValue = await sender.replaceTrack(newTrack);

    expect(resolvedValue).toBe("replace-track-resolved-value");
    expect(onAudioTrackReplaced).toHaveBeenCalledWith(newTrack, oldTrack);
    expect(logs).toContainEqual({
      event: "sender-replace-track",
      details: { kind: "audio", previousTrackId: "old", newTrackId: "new" },
    });
  });

  it("does not call onAudioTrackReplaced for a video sender's track replacement", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    const onAudioTrackReplaced = vi.fn();
    installReplaceTrackPatch({ onAudioTrackReplaced });

    const oldTrack = { kind: "video", id: "old-v" };
    const newTrack = { kind: "video", id: "new-v" };
    const sender = new window.RTCRtpSender(oldTrack);
    await sender.replaceTrack(newTrack);

    expect(onAudioTrackReplaced).not.toHaveBeenCalled();
  });

  it("still calls through to the original replaceTrack behavior", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    installReplaceTrackPatch({ onAudioTrackReplaced: () => {} });

    const oldTrack = fakeAudioTrack("old");
    const newTrack = fakeAudioTrack("new");
    const sender = new window.RTCRtpSender(oldTrack);
    await sender.replaceTrack(newTrack);

    expect(sender.track).toBe(newTrack);
  });

  it("does not call onAudioTrackReplaced if the underlying replaceTrack call rejects", async () => {
    // Real gap Codex's review caught in the first version of this plan: firing
    // onAudioTrackReplaced before awaiting the original call would switch the
    // mixer to a track that Meet's own replaceTrack call never actually
    // accepted.
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    window.RTCRtpSender = class {
      constructor(track) {
        this.track = track;
      }
      async replaceTrack() {
        throw new Error("replaceTrack failed");
      }
    };
    const onAudioTrackReplaced = vi.fn();
    installReplaceTrackPatch({ onAudioTrackReplaced });

    const sender = new window.RTCRtpSender(fakeAudioTrack("old"));
    await expect(sender.replaceTrack(fakeAudioTrack("new"))).rejects.toThrow("replaceTrack failed");
    expect(onAudioTrackReplaced).not.toHaveBeenCalled();
  });

  it("increments diagnostics.audioSenderReplacements only for successful audio sender replacements", async () => {
    vi.resetModules();
    const { installReplaceTrackPatch, diagnostics } = await import("./rtc-patch.js");
    installReplaceTrackPatch({ onAudioTrackReplaced: () => {} });

    const sender = new window.RTCRtpSender(fakeAudioTrack("old"));
    await sender.replaceTrack(fakeAudioTrack("new"));
    await sender.replaceTrack(fakeAudioTrack("newer"));

    expect(diagnostics.audioSenderReplacements).toBe(2);
  });

  it("does not double-wrap replaceTrack when installed more than once", async () => {
    // Guards against Meet triggering two log lines / two callback firings for
    // one real replaceTrack call if installReplaceTrackPatch were ever
    // (accidentally) called twice.
    vi.resetModules();
    const { installReplaceTrackPatch } = await import("./rtc-patch.js");
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    installReplaceTrackPatch({ onAudioTrackReplaced: firstCallback });
    installReplaceTrackPatch({ onAudioTrackReplaced: secondCallback });

    const sender = new window.RTCRtpSender(fakeAudioTrack("old"));
    await sender.replaceTrack(fakeAudioTrack("new"));

    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/webrtc-bootstrap/rtc-patch.test.js`
Expected: FAIL — the 11 new tests fail because `getCurrentLocalAudioTrack` and `installReplaceTrackPatch` don't exist yet, and `diagnostics` has no `audioSenderReplacements` field. The 13 pre-existing tests should still pass.

- [ ] **Step 4: Implement the changes**

In `src/webrtc-bootstrap/rtc-patch.js`, change:

```js
// src/webrtc-bootstrap/rtc-patch.js
export const diagnostics = {
  installedAt: Date.now(),
  peerConnectionsCreated: 0,
  remoteAudioTracksSeen: 0,
  micTracksSeen: 0,
  connectionsClosed: 0,
};

let nextConnectionId = 1;
const connectionIds = new WeakMap();

function getConnectionId(pc) {
  if (!connectionIds.has(pc)) connectionIds.set(pc, nextConnectionId++);
  return connectionIds.get(pc);
}
```

to:

```js
// src/webrtc-bootstrap/rtc-patch.js
export const diagnostics = {
  installedAt: Date.now(),
  peerConnectionsCreated: 0,
  remoteAudioTracksSeen: 0,
  micTracksSeen: 0,
  connectionsClosed: 0,
  audioSenderReplacements: 0,
};

let nextConnectionId = 1;
const connectionIds = new WeakMap();
// Conexiones parcheadas que siguen abiertas — permite, en cualquier momento,
// mirar qué track de audio se está enviando AHORA (ver getCurrentLocalAudioTrack),
// en vez de depender únicamente del track que getUserMedia devolvió una sola
// vez al principio.
const activeConnections = new Set();

function getConnectionId(pc) {
  if (!connectionIds.has(pc)) connectionIds.set(pc, nextConnectionId++);
  return connectionIds.get(pc);
}
```

Then update `installRtcPatch` to populate/clear `activeConnections`. Change:

```js
    const pc = new OriginalRTCPeerConnection(...args);
    diagnostics.peerConnectionsCreated += 1;
    // Asignado acá mismo (no de forma perezosa en el primer "track"/close) para
    // que cada conexión parcheada tenga su identidad desde el momento en que se
    // crea, no solo desde su primer evento.
    const connectionId = getConnectionId(pc);
```

to:

```js
    const pc = new OriginalRTCPeerConnection(...args);
    diagnostics.peerConnectionsCreated += 1;
    // Asignado acá mismo (no de forma perezosa en el primer "track"/close) para
    // que cada conexión parcheada tenga su identidad desde el momento en que se
    // crea, no solo desde su primer evento.
    const connectionId = getConnectionId(pc);
    activeConnections.add(pc);
```

Then change:

```js
    pc.addEventListener("connectionstatechange", () => {
      log("connection-state-changed", { connectionId, connectionState: pc.connectionState });
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        diagnostics.connectionsClosed += 1;
        onConnectionClosed(connectionId);
      }
    });
```

to:

```js
    pc.addEventListener("connectionstatechange", () => {
      log("connection-state-changed", { connectionId, connectionState: pc.connectionState });
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        diagnostics.connectionsClosed += 1;
        activeConnections.delete(pc);
        onConnectionClosed(connectionId);
      }
    });
```

Then, at the end of the file (after `installGetUserMediaPatch`), add the two new exports:

```js
// Busca, entre las conexiones parcheadas que siguen abiertas, el track de
// audio que ACTUALMENTE se está enviando (el que devuelve cada
// RTCRtpSender.track) — a diferencia de installGetUserMediaPatch, que solo
// ve el track original de la primera vez que Meet pidió el micrófono. Si
// Meet reemplazó ese track más tarde (ver installReplaceTrackPatch), esto
// devuelve el reemplazo; el original capturado por getUserMedia queda
// obsoleto y no se usa acá.
//
// Puede haber más de un candidato (más de una conexión con un sender de
// audio activo). Entre ellos, se prioriza uno cuya conexión esté realmente
// "connected" por sobre uno que simplemente no llegó todavía a "closed"/
// "failed" (p. ej. "new" o "disconnected") — Codex's review señaló que
// tomar el primer candidato sin este criterio podía elegir una conexión
// obsoleta en vez de la realmente activa. Se loguean todos los candidatos
// considerados (no solo el elegido) para poder diagnosticar esto si hace
// falta.
export function getCurrentLocalAudioTrack({ log = () => {} } = {}) {
  const candidates = [];
  for (const pc of activeConnections) {
    if (pc.connectionState === "closed" || pc.connectionState === "failed") continue;
    let senders;
    try {
      senders = pc.getSenders();
    } catch {
      continue;
    }
    for (const sender of senders) {
      if (sender.track && sender.track.kind === "audio") {
        candidates.push({
          track: sender.track,
          connectionId: getConnectionId(pc),
          connectionState: pc.connectionState,
        });
      }
    }
  }

  if (candidates.length === 0) {
    log("current-local-audio-track-lookup", { candidateCount: 0, selectedTrackId: null });
    return null;
  }

  const connected = candidates.find((candidate) => candidate.connectionState === "connected");
  const selected = connected ?? candidates[0];
  log("current-local-audio-track-lookup", {
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      trackId: candidate.track.id,
      connectionId: candidate.connectionId,
      connectionState: candidate.connectionState,
    })),
    selectedTrackId: selected.track.id,
  });
  return selected.track;
}

let replaceTrackPatchInstalled = false;

// Detecta cuándo Meet reemplaza el track de audio que efectivamente se está
// enviando (RTCRtpSender.replaceTrack) — algo que installGetUserMediaPatch,
// por sí solo, nunca ve, porque esa función solo se entera del track
// original devuelto por getUserMedia() la primera vez. Hipótesis de esta
// investigación (revisada por Codex dos veces como plausible pero NO
// confirmada contra una reunión real): si Meet vuelve a llamar replaceTrack
// con un track ya procesado internamente (con su propio control de
// volumen/normalización), seguir usando el track original sin enterarnos
// del reemplazo explicaría por qué la voz propia grabada suena más baja que
// en Fireflies, que sí detecta estos reemplazos (confirmado inspeccionando
// su código).
//
// onAudioTrackReplaced se dispara DESPUÉS de que el replaceTrack original se
// resuelve con éxito, no antes — si Meet intenta un reemplazo que termina
// rechazado, no queremos que el mixer igual cambie de track (bug real que
// Codex encontró en la primera versión de este plan). Se dispara para
// CUALQUIER reemplazo exitoso de un sender de audio, incluido un reemplazo a
// `null` (Meet deja de enviar audio, un uso legítimo de replaceTrack) — esta
// función no filtra ese caso; es quien la llama el que decide qué hacer con
// un `newTrack` nulo (ver bootstrap.js, que documenta explícitamente esa
// decisión en vez de ignorarla en silencio).
//
// Idempotente: una segunda llamada a installReplaceTrackPatch() no vuelve a
// envolver replaceTrack (evita duplicar logs/callbacks si por error se
// llamara dos veces).
export function installReplaceTrackPatch({ onAudioTrackReplaced, log = () => {} }) {
  if (replaceTrackPatchInstalled) return;
  if (!window.RTCRtpSender || !window.RTCRtpSender.prototype.replaceTrack) return;
  replaceTrackPatchInstalled = true;
  const originalReplaceTrack = window.RTCRtpSender.prototype.replaceTrack;

  window.RTCRtpSender.prototype.replaceTrack = function (newTrack) {
    const previousTrack = this.track;
    const kind = previousTrack?.kind ?? newTrack?.kind ?? null;
    log("sender-replace-track", {
      kind,
      previousTrackId: previousTrack?.id ?? null,
      newTrackId: newTrack?.id ?? null,
    });
    return originalReplaceTrack.call(this, newTrack).then((result) => {
      if (kind === "audio") {
        diagnostics.audioSenderReplacements += 1;
        onAudioTrackReplaced(newTrack, previousTrack);
      }
      return result;
    });
  };
}
```

No other part of `rtc-patch.js` changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/webrtc-bootstrap/rtc-patch.test.js`
Expected: PASS (24 tests — 13 pre-existing plus these 11 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/webrtc-bootstrap/rtc-patch.js src/webrtc-bootstrap/rtc-patch.test.js
git commit -m "feat: detect the live outgoing audio track via RTCRtpSender.replaceTrack"
```

---

### Task 2: Wire bootstrap.js to prefer the live sender track and react to mid-session replacements

**Files:**
- Modify: `src/webrtc-bootstrap/bootstrap.js`

- [ ] **Step 1: Track mute state explicitly instead of inferring it from the mixer's gain node**

The mixer already exposes `micGainNode.gain.value`, but reading that to decide "is the mic currently muted" is brittle — during the short ramp `setMicMuted()` uses (see `src/webrtc-bootstrap/audio-mixer.js`), the value briefly passes through intermediate numbers, and it's an implementation detail of the mixer that `bootstrap.js` shouldn't need to reach into. `bootstrap.js` already receives explicit `asterion:mic-muted`/`asterion:mic-unmuted` messages — track the current state directly from those.

In `src/webrtc-bootstrap/bootstrap.js`, change:

```js
let micTrack = null;
let session = null;
```

to:

```js
let micTrack = null;
let session = null;
let currentlyMuted = false;
```

Then change:

```js
  } else if (message.type === "asterion:mic-muted") {
    session?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    session?.onMicUnmuted(message.timestampMs);
```

to:

```js
  } else if (message.type === "asterion:mic-muted") {
    currentlyMuted = true;
    session?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    currentlyMuted = false;
    session?.onMicUnmuted(message.timestampMs);
```

- [ ] **Step 2: Update the imports and install the new patch**

Change:

```js
import { installRtcPatch, installGetUserMediaPatch, diagnostics } from "./rtc-patch.js";
import { MeetingAudioMixer } from "./audio-mixer.js";
import { MainWorldSession } from "./session.js";

console.log("[Asterion:debug] bootstrap (MAIN world) cargado");

const mixer = new MeetingAudioMixer({
  log: (event, details) => console.debug(`[Asterion:audio-mixer] ${event}`, details),
});
mixer.resume().catch(() => {});
let micTrack = null;
let session = null;
let currentlyMuted = false;

installRtcPatch({
  onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
  onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
  log: (event, details) => console.debug(`[Asterion:rtc-patch] ${event}`, details),
});

installGetUserMediaPatch({
  onMicStream: (stream, audioTrack) => {
    micTrack = audioTrack;
  },
});
```

to:

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

const rtcPatchLog = (event, details) => console.debug(`[Asterion:rtc-patch] ${event}`, details);

console.log("[Asterion:debug] bootstrap (MAIN world) cargado");

const mixer = new MeetingAudioMixer({
  log: (event, details) => console.debug(`[Asterion:audio-mixer] ${event}`, details),
});
mixer.resume().catch(() => {});
let micTrack = null;
let session = null;
let currentlyMuted = false;

installRtcPatch({
  onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
  onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
  log: rtcPatchLog,
});

installGetUserMediaPatch({
  onMicStream: (stream, audioTrack) => {
    micTrack = audioTrack;
  },
});

installReplaceTrackPatch({
  onAudioTrackReplaced: (newTrack) => {
    if (!newTrack) {
      // replaceTrack(null) es un uso legítimo de la API (Meet deja de enviar
      // audio saliente por esa conexión) — no significa que el micrófono real
      // dejó de andar, así que seguimos usando el último track bueno que
      // tenemos en vez de cortar la grabación. Se deja logueado explícitamente
      // para poder ver si esto pasa en la práctica.
      rtcPatchLog("mic-track-replaced-with-null", {});
      return;
    }
    micTrack = newTrack;
    if (session) {
      // Grabación en curso: no alcanza con actualizar `micTrack` para la
      // próxima vez — hay que reconectar el mixer YA con el track nuevo, o
      // seguiríamos mezclando el viejo hasta el final de la sesión.
      //
      // Límite conocido, no resuelto en este plan: MeetingAudioMixer.setMicTrack()
      // desconecta el nodo de audio viejo y conecta uno nuevo de forma directa
      // (sin rampa), a diferencia de setMicMuted(), que sí usa una rampa corta
      // para evitar un "click" audible. Un reemplazo de track en vivo podría
      // sonar con un salto/click perceptible en el archivo grabado. No se
      // agrega una rampa acá todavía porque no hay evidencia de que esto pase
      // en la práctica (un replaceTrack en vivo, a mitad de una grabación, es
      // el caso menos común de los que este plan cubre) — si la verificación
      // manual (Tarea 3) confirma que sí se nota, esa rampa es el siguiente
      // paso, no algo para adivinar ahora.
      mixer.setMicTrack(newTrack, { initiallyMuted: currentlyMuted });
    }
  },
  log: rtcPatchLog,
});
```

- [ ] **Step 3: Prefer the live sender track when a session starts**

In the same file, change:

```js
  if (message.type === "asterion:start-session") {
    console.log("[Asterion:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {
      sessionId: message.sessionId,
      mixer,
      session,
    });
    if (!micTrack) {
      postToIsolated({ type: "asterion:start-failed", sessionId: message.sessionId, reason: "no-mic-stream" });
      return;
    }
    mixer.setMicTrack(micTrack, { initiallyMuted: Boolean(message.initialMicMuted) });
```

to:

```js
  if (message.type === "asterion:start-session") {
    console.log("[Asterion:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {
      sessionId: message.sessionId,
      mixer,
      session,
    });
    // Se prefiere el track que la conexión ACTIVA está enviando ahora mismo
    // (por si Meet ya reemplazó el original antes de que arrancara la
    // grabación) por sobre el que getUserMedia devolvió una sola vez al
    // principio. Si por algo no hay ninguna conexión con un sender de audio
    // todavía (p. ej. la reunión recién está arrancando), se cae al track de
    // getUserMedia como venía haciendo antes.
    const liveAudioTrack = getCurrentLocalAudioTrack({ log: rtcPatchLog });
    const trackToUse = liveAudioTrack ?? micTrack;
    currentlyMuted = Boolean(message.initialMicMuted);
    rtcPatchLog("mic-track-resolved-for-session-start", {
      source: liveAudioTrack ? "sender-lookup" : "getUserMedia-fallback",
      trackId: trackToUse?.id ?? null,
    });
    if (!trackToUse) {
      postToIsolated({ type: "asterion:start-failed", sessionId: message.sessionId, reason: "no-mic-stream" });
      return;
    }
    mixer.setMicTrack(trackToUse, { initiallyMuted: currentlyMuted });
```

No other part of `bootstrap.js` changes.

- [ ] **Step 4: Run the full test suite and the build**

Run: `npm test`
Expected: PASS, all suites green (`bootstrap.js` has no dedicated unit tests — same as before, it's DOM/`chrome`/`window`-driven orchestration code — so this just confirms nothing else broke).

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/bootstrap.js
git commit -m "feat: resolve the live outgoing mic track at session start and react to mid-session swaps"
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

- [ ] **Step 3: Manual verification (report what could and couldn't be checked)**

This needs the same kind of A/B test the user already ran twice — report explicitly which of these were actually checked versus skipped:
1. Record a meeting again (same conditions as the prior quiet-mic report, ideally another A/B against Fireflies) and confirm whether the user's own voice is now at a comparable volume to before, or still quiet.
2. Regardless of the outcome, open DevTools console during the recording and look at the `[Asterion:rtc-patch]` log lines to reach one of these conclusions, not just "louder/still quiet":
   - **`sender-replace-track` with `kind: "audio"` appears at all:** Meet *did* replace the outgoing mic track at least once — note the `previousTrackId`/`newTrackId` pair and roughly when it happened (before the recording started, vs. mid-recording — the latter is what Task 2's live-update path handles; the former is what the session-start `sender-lookup` resolution handles).
   - **No `sender-replace-track` audio entries appear at all, AND `mic-track-resolved-for-session-start`/other `[Asterion:rtc-patch]` logs ARE otherwise present (proving the patch did install and log normally):** this is a real disconfirmation — Meet never swapped the track in this reproduction. If the mic is still quiet in this case, this plan's hypothesis was wrong (or at least incomplete) for this reproduction, and a fresh investigation is needed rather than assuming this fix "should" have worked.
   - **No `[Asterion:rtc-patch]` logs of any kind appear:** inconclusive, not a disconfirmation — per this plan's caveat about `document_start` timing, there's no way to tell from this alone whether the patch failed to install or simply had nothing to report. Check for a `mic-track-resolved-for-session-start` log specifically (it always fires once per session start, regardless of whether a replacement ever happened) as a sanity check that the patch is alive at all.
   - Also check `mic-track-resolved-for-session-start`'s `source` field — `"sender-lookup"` vs `"getUserMedia-fallback"` — and, if there are multiple candidates, the `current-local-audio-track-lookup` log's `candidates` array (does more than one audio sender show up? is the `connectionState` selection picking the one that seems right?).
3. If a live `sender-replace-track` fired mid-session, listen specifically around that moment in the recording for an audible glitch/gap/click (see the known-limitation note in Task 2 Step 2 about `setMicTrack()` not using a gain ramp like `setMicMuted()` does) — report whether one is audible.

- [ ] **Step 4: Commit** (only if step 3 uncovers something that needs a follow-up fix; otherwise this task produces no code changes to commit)
