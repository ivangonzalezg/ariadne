# Audio Mixer Global Stream Keying + Connection Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-specific override:** in this repo, tasks are delegated to and executed by the `codex:codex-rescue` agent (Codex), not by generic Claude subagents — see `CLAUDE.md`. Claude reviews each task's result against this plan before moving to the next one.

**Goal:** Fix a confirmed echo the user hears specifically from Asterion (not from Fireflies, verified via a controlled A/B test recording the same Meet call with both extensions simultaneously) by changing how remote audio sources are identified in the mixer — from connection-scoped to globally keyed by `MediaStream.id`, matching the approach a decompiled Fireflies build uses — plus add diagnostic logging in `rtc-patch.js` so the exact mechanism can be confirmed from real DevTools output if this doesn't fully resolve it.

**Architecture:** `MeetingAudioMixer._remoteKey()` currently returns `${connectionId}:${streamId ?? mid ?? track.id}` — every remote source is scoped to the specific `RTCPeerConnection` it arrived on. If Google Meet ever reuses the same `MediaStream.id` for the same participant across a connection replacement or renegotiation (a new `RTCPeerConnection`, hence a new `connectionId`, carrying a `track` event whose stream id matches one we already have tracked under the *old* connection), our current scheme treats that as an unrelated new source instead of a replacement — both the old and new copies can end up connected to the mix destination simultaneously, which sounds exactly like the reported echo. This plan changes the key to use `stream.id` alone (globally, not connection-scoped) when a `MediaStream` is available, keeping `mid`/`track.id` as connection-scoped fallbacks only for the rare case where no stream is attached to the track event (`mid` specifically must stay connection-scoped, since SDP media-line ids are small integers like `"0"`/`"1"` that restart per connection and would otherwise collide across unrelated connections). Per-connection cleanup (`removeConnection()`) is unaffected — it already tracks ownership via `entry.connectionId` stored on each tracked source, independent of what the key string looks like.

**Tech Stack:** Same as the rest of this audio investigation — vanilla JS Web Audio/WebRTC APIs, Vitest with the hand-written fakes already in `src/webrtc-bootstrap/audio-mixer.test.js` and `src/webrtc-bootstrap/rtc-patch.test.js`.

**Context — how we got here:** This is the fourth plan in an ongoing audio-quality investigation this session (see `docs/superpowers/plans/2026-09-21-audio-mixer-lifecycle-fix.md`, `docs/superpowers/plans/2026-09-21-audio-mixer-channel-config.md`, both already shipped). After those fixes, the user reported a persistent mild echo and initially attributed it to acoustic leakage through a laptop speaker into an open mic (a real, separate, physical phenomenon — documented as a known limitation in `asterion-alcance.md`, section 6). To validate that theory, the user ran a controlled test: recording the *same* Google Meet call *at the same time* with both Asterion and Fireflies, switching from speaker to headphones partway through. Asterion had an audible echo throughout (before and after switching to headphones); Fireflies did not, in either condition. Since a pure acoustic-leak explanation would affect both tools equally (neither one requests special microphone constraints — both simply read whatever track Google Meet's own `getUserMedia` call already produced), the fact that only Asterion is affected points to something structurally different between the two extensions, not a physical/acoustic cause.

Re-inspecting the decompiled Fireflies bundle (legitimately extracted from its public `.crx`, same as earlier in this investigation) confirmed: they have zero echo/gain-related processing of any kind (no `GainNode`, no compressor, no voice-activity detection, no explicit `echoCancellation` constraints) — their local mic and every remote participant connect the same way, `audioContext.createMediaStreamSource(stream).connect(destination)`, directly. The one concrete, verified structural difference: they track every audio source in a single global `Map` keyed by `MediaStream.id`, with **no connection-scoping at all** — a repeated `stream.id`, even from a different `RTCPeerConnection`, is treated as the same logical source and simply skipped/replaced, never duplicated. Codex reviewed this hypothesis and confirmed it's plausible and code-consistent, given `rtc-patch.js` only calls `onConnectionClosed()` when a connection reaches `"closed"`/`"failed"` — a connection that lingers in another state (or closes with any delay) while a *new* connection has already taken over the same participant's audio would let both remain mixed simultaneously under our current connection-scoped keying.

Codex's recommended design (adopted here): keep `connectionId` on each tracked entry for cleanup purposes (unaffected), but make the *key* itself global when a `stream.id` is available — matching Fireflies' proven-working behavior — while keeping the `mid`/`track.id` fallbacks connection-scoped (since those two, unlike `stream.id`, are not safe to treat as globally unique).

---

## File Structure

- Modify: `src/webrtc-bootstrap/audio-mixer.js` — change `_remoteKey()`'s key formula (global by `stream.id`, connection-scoped fallback for `mid`/`track.id`).
- Modify: `src/webrtc-bootstrap/audio-mixer.test.js` — update the one existing test that encoded the old (now-wrong) "different connections with the same stream id stay separate" behavior, and add tests locking in the new behavior and the fallback collision-avoidance behavior.
- Modify: `src/webrtc-bootstrap/rtc-patch.js` — add an optional `log` callback, called with full context (`connectionId`, `connectionState`, `streamId`, `mid`, `trackId`) on every audio `"track"` event and every `"connectionstatechange"` — this is the evidence-gathering half of this plan, independent of whether the keying change alone resolves the echo.
- Modify: `src/webrtc-bootstrap/rtc-patch.test.js` — add tests for the new logging.
- Modify: `src/webrtc-bootstrap/bootstrap.js` — pass a `log` option into `installRtcPatch(...)`, matching the pattern already used for `MeetingAudioMixer`'s `log` option.

---

### Task 1: Change remote-source keying to be global by stream id

**Files:**
- Modify: `src/webrtc-bootstrap/audio-mixer.js`
- Modify: `src/webrtc-bootstrap/audio-mixer.test.js`

- [ ] **Step 1: Update the existing test that encodes the old behavior, and add new tests for the new behavior**

In `src/webrtc-bootstrap/audio-mixer.test.js`, the existing test `"keeps sources from different connections separate even with the same stream id"` directly tests the behavior this plan is changing — it must be replaced, not kept alongside the new one (keeping both would make the suite self-contradictory). Change:

```js
  it("keeps sources from different connections separate even with the same stream id", () => {
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s1"), mid: null, connectionId: 2 });

    expect(mixer.activeRemoteSourceCount).toBe(2);
  });
```

to:

```js
  it("treats the same stream id as the same logical source across different connections (replaces, not duplicates)", () => {
    // This is the targeted hypothesis for the echo the user confirmed via an A/B
    // recording against Fireflies (not yet confirmed as THE cause against a real
    // Meet call — see Task 2's logging and Task 3's manual verification for how
    // that gets confirmed or ruled out): IF Google Meet reuses the same
    // MediaStream.id for a participant across a connection replacement (new
    // RTCPeerConnection, new connectionId), the old and new copies must not both
    // stay connected to the mix — that would produce an audible doubling.
    const { mixer, sourceNodes } = makeMixer();
    const firstTrack = fakeTrack("t1");
    const secondTrack = fakeTrack("t2");
    mixer.addRemoteTrack({ track: firstTrack, stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: secondTrack, stream: fakeStream("s1"), mid: null, connectionId: 2 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
  });

  it("does not remove a replaced source when its OLD connection later closes, and the replacement stays removable under its real owner", () => {
    // Locks in that connectionKeys bookkeeping still follows the entry's actual
    // owning connection (tracked separately from the key string itself), not the
    // connection that originally created the key — both directions: closing the
    // OLD connection must not touch the replacement, and closing the NEW
    // (actual owning) connection must still clean it up correctly.
    const { mixer, sourceNodes } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s1"), mid: null, connectionId: 2 });

    mixer.removeConnection(1);
    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();

    mixer.removeConnection(2);
    expect(mixer.activeRemoteSourceCount).toBe(0);
    expect(sourceNodes[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps sources from different connections separate when falling back to mid (no stream), even with the same mid", () => {
    // mid ("0", "1", ...) is a per-connection SDP media-line id, not globally
    // unique — unlike stream.id, it's NOT safe to treat as the same logical
    // source across connections. This test locks in that the mid fallback stays
    // connection-scoped.
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: null, mid: "0", connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: null, mid: "0", connectionId: 2 });

    expect(mixer.activeRemoteSourceCount).toBe(2);
  });

  it("does NOT migrate an entry from a mid-fallback key to a stream key if a stream becomes available later on the same connection+mid (known, accepted gap)", () => {
    // There is no alias/migration mechanism between the two keying schemes. If a
    // track first arrives with no stream (falls back to conn:<id>:mid:<mid>) and
    // a later track for the same connection+mid DOES have a stream (keys as
    // stream:<id>), they're treated as two unrelated sources, not one — this
    // test documents that as a known, deliberately-accepted gap (Codex's review
    // flagged it as an untested risk; YAGNI applies until real evidence from the
    // Task 2 diagnostic logging shows this transition actually happens against a
    // real Meet call and causes a problem worth fixing).
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: null, mid: "0", connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s1"), mid: "0", connectionId: 1 });

    expect(mixer.activeRemoteSourceCount).toBe(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/webrtc-bootstrap/audio-mixer.test.js`
Expected: FAIL — the "treats the same stream id as the same logical source..." and "does not remove a replaced source when its OLD connection later closes..." tests fail against the current connection-scoped `_remoteKey()` (the "keeps sources... separate when falling back to mid" and the mid→stream migration-gap test should already pass unchanged, since they describe connection-scoped behavior that isn't changing). The rest of the suite (21 other pre-existing tests) should still pass.

- [ ] **Step 3: Implement the change**

In `src/webrtc-bootstrap/audio-mixer.js`, change:

```js
  _remoteKey(connectionId, { streamId, mid, track }) {
    return `${connectionId}:${streamId ?? mid ?? track.id}`;
  }
```

to:

```js
  // Global por stream.id cuando hay un MediaStream disponible — así, SI Meet
  // reutiliza el mismo MediaStream.id para el mismo participante al reconectar o
  // renegociar (con una RTCPeerConnection nueva, y por lo tanto un connectionId
  // distinto), lo tratamos como la MISMA fuente y la reemplazamos (ver
  // addRemoteTrack) en vez de sumar una copia adicional. Esta es la hipótesis
  // objetivo para el eco que el usuario detectó comparando contra Fireflies
  // (cuyo código usa este mismo esquema global) — confirmada como plausible por
  // dos revisiones de Codex, pero todavía no confirmada contra una reunión real;
  // ver el logging de diagnóstico en rtc-patch.js y la verificación manual del
  // plan que introdujo este cambio para cómo se termina de confirmar o
  // descartar. `mid` NO es seguro tratarlo así: son enteros chicos ("0", "1",
  // ...) que se reinician por conexión, así que dos conexiones distintas casi
  // seguro van a tener el mismo mid para participantes DISTINTOS — por eso ese
  // fallback (y el de track.id) se mantienen scopeados a la conexión.
  _remoteKey(connectionId, { streamId, mid, track }) {
    if (streamId) return `stream:${streamId}`;
    if (mid) return `conn:${connectionId}:mid:${mid}`;
    return `conn:${connectionId}:track:${track.id}`;
  }
```

No other part of `audio-mixer.js` changes — `addRemoteTrack`'s replace-on-same-key logic, `_teardownEntry`'s per-connection cleanup bookkeeping (keyed by `entry.connectionId`, not by the key string), and `removeConnection()` are all already correct for this change without modification.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/webrtc-bootstrap/audio-mixer.test.js`
Expected: PASS (27 tests — 24 from before, minus the 1 replaced test, plus the 4 new ones: 24 − 1 + 4 = 27).

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/audio-mixer.js src/webrtc-bootstrap/audio-mixer.test.js
git commit -m "fix: key remote audio sources globally by stream id instead of per-connection"
```

---

### Task 2: Add connection/track diagnostic logging to rtc-patch.js

**Files:**
- Modify: `src/webrtc-bootstrap/rtc-patch.js`
- Modify: `src/webrtc-bootstrap/rtc-patch.test.js`
- Modify: `src/webrtc-bootstrap/bootstrap.js`

This task is independent evidence-gathering, valuable regardless of whether Task 1 alone resolves the echo: it logs every audio `"track"` event and every `"connectionstatechange"` with enough detail (`connectionId`, `connectionState`, `streamId`, `mid`, `trackId`) that if the echo is ever reproduced again, the DevTools console will show directly whether two different `connectionId`s carried the same `streamId` (confirming Task 1's fix targeted the right mechanism) or something else entirely (e.g. genuinely different `streamId`s overlapping, which would point to a different problem Task 1 doesn't address).

- [ ] **Step 1: Write the failing tests**

In `src/webrtc-bootstrap/rtc-patch.test.js`, add two new tests inside the existing `describe("installRtcPatch", ...)` block (after any existing test — order doesn't matter):

```js
  it("logs remote-track-observed with full context for every audio track event", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const logs = [];
    installRtcPatch({
      onRemoteAudioTrack: () => {},
      onConnectionClosed: () => {},
      log: (event, details) => logs.push({ event, details }),
    });
    const pc = new window.RTCPeerConnection();
    const track = fakeAudioTrack("t1");
    const stream = { id: "s1" };
    pc._emit("track", { track, streams: [stream], transceiver: { mid: "0" } });

    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe("remote-track-observed");
    expect(logs[0].details).toMatchObject({
      connectionState: "new",
      streamId: "s1",
      mid: "0",
      trackId: "t1",
    });
    expect(typeof logs[0].details.connectionId).toBe("number");
  });

  it("logs connection-state-changed on every connectionstatechange, not only closed/failed", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const logs = [];
    installRtcPatch({
      onRemoteAudioTrack: () => {},
      onConnectionClosed: () => {},
      log: (event, details) => logs.push({ event, details }),
    });
    const pc = new window.RTCPeerConnection();

    pc._setConnectionState("connected");
    pc._setConnectionState("disconnected");
    pc._setConnectionState("closed");

    const stateChangeLogs = logs.filter((entry) => entry.event === "connection-state-changed");
    expect(stateChangeLogs.map((entry) => entry.details.connectionState)).toEqual([
      "connected",
      "disconnected",
      "closed",
    ]);
  });
```

The two tests above confirm the logging exists, but neither actually proves the `remote-track-observed` log fires *before* the closed/failed early-return guard specifically — a test using a `"new"`-state connection can't distinguish "logged before the guard" from "logged after," since the guard never triggers in that state either way. To prove the placement matters, extend the existing `"ignores a track event when the connection is already closed"` test (already in this file, from the lifecycle-fix plan) to also capture logs and assert the log fires *despite* `onRemoteAudioTrack` being skipped. Change:

```js
  it("ignores a track event when the connection is already closed", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc.connectionState = "closed";
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    expect(onRemoteAudioTrack).not.toHaveBeenCalled();
  });
```

to:

```js
  it("ignores a track event when the connection is already closed, but still logs it for diagnostics", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    const logs = [];
    installRtcPatch({
      onRemoteAudioTrack,
      onConnectionClosed: () => {},
      log: (event, details) => logs.push({ event, details }),
    });
    const pc = new window.RTCPeerConnection();
    pc.connectionState = "closed";
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });

    expect(onRemoteAudioTrack).not.toHaveBeenCalled();
    expect(logs).toContainEqual({
      event: "remote-track-observed",
      details: { connectionId: expect.any(Number), connectionState: "closed", streamId: null, mid: null, trackId: "t1" },
    });
  });
```

(This is a modification of an existing test, not a new one — it doesn't change the total test count.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/webrtc-bootstrap/rtc-patch.test.js`
Expected: FAIL — the two new tests fail because `installRtcPatch` doesn't accept/call a `log` option yet, and the modified closed-connection test fails because it now expects a log entry that doesn't exist yet. The other 10 pre-existing tests in this file should still pass.

- [ ] **Step 3: Implement the logging**

In `src/webrtc-bootstrap/rtc-patch.js`, change:

```js
export function installRtcPatch({ onRemoteAudioTrack, onConnectionClosed }) {
  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) return;

  function PatchedRTCPeerConnection(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    diagnostics.peerConnectionsCreated += 1;
    // Asignado acá mismo (no de forma perezosa en el primer "track"/close) para
    // que cada conexión parcheada tenga su identidad desde el momento en que se
    // crea, no solo desde su primer evento.
    const connectionId = getConnectionId(pc);

    pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      if (pc.connectionState === "closed" || pc.connectionState === "failed") return;
      diagnostics.remoteAudioTracksSeen += 1;
      onRemoteAudioTrack({
        track: event.track,
        stream: event.streams?.[0] ?? null,
        mid: event.transceiver?.mid ?? null,
        connectionId,
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        diagnostics.connectionsClosed += 1;
        onConnectionClosed(connectionId);
      }
    });

    return pc;
  }
```

to:

```js
export function installRtcPatch({ onRemoteAudioTrack, onConnectionClosed, log = () => {} }) {
  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) return;

  function PatchedRTCPeerConnection(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    diagnostics.peerConnectionsCreated += 1;
    // Asignado acá mismo (no de forma perezosa en el primer "track"/close) para
    // que cada conexión parcheada tenga su identidad desde el momento en que se
    // crea, no solo desde su primer evento.
    const connectionId = getConnectionId(pc);

    pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      const streamId = event.streams?.[0]?.id ?? null;
      const mid = event.transceiver?.mid ?? null;
      // Logueado ANTES del guard de closed/failed a propósito: si alguna vez
      // llega un "track" tarde para una conexión ya cerrada, queremos verlo acá
      // (con connectionState reflejando ese estado) aunque onRemoteAudioTrack no
      // se termine llamando.
      log("remote-track-observed", {
        connectionId,
        connectionState: pc.connectionState,
        streamId,
        mid,
        trackId: event.track.id,
      });
      if (pc.connectionState === "closed" || pc.connectionState === "failed") return;
      diagnostics.remoteAudioTracksSeen += 1;
      onRemoteAudioTrack({
        track: event.track,
        stream: event.streams?.[0] ?? null,
        mid,
        connectionId,
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      log("connection-state-changed", { connectionId, connectionState: pc.connectionState });
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        diagnostics.connectionsClosed += 1;
        onConnectionClosed(connectionId);
      }
    });

    return pc;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/webrtc-bootstrap/rtc-patch.test.js`
Expected: PASS (13 tests — 11 pre-existing plus these 2 new ones).

- [ ] **Step 5: Wire the log option in bootstrap.js**

In `src/webrtc-bootstrap/bootstrap.js`, change:

```js
installRtcPatch({
  onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
  onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
});
```

to:

```js
installRtcPatch({
  onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
  onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
  log: (event, details) => console.debug(`[Asterion:rtc-patch] ${event}`, details),
});
```

- [ ] **Step 6: Run the full test suite and the build**

Run: `npm test`
Expected: PASS, all suites green.

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/webrtc-bootstrap/rtc-patch.js src/webrtc-bootstrap/rtc-patch.test.js src/webrtc-bootstrap/bootstrap.js
git commit -m "debug: log every remote track observation and connection state change"
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

This needs the same kind of A/B test the user already ran once — report explicitly which of these were actually checked versus skipped:
1. Record a meeting again (ideally reproducing the same speaker/headphones conditions as the original A/B test) and confirm whether the echo is now gone or reduced.
2. Whether or not the echo is gone, open DevTools console during the recording and reconstruct the **ordered** sequence of `[Asterion:rtc-patch] remote-track-observed`, `[Asterion:audio-mixer] remote-track-added`/`remote-track-removed`, and `[Asterion:rtc-patch] connection-state-changed` log lines (by timestamp, as they actually appear in the console — not just grepped independently) for the period when the echo was audible (or would have been, pre-fix). Use that sequence to reach one of these three specific conclusions, not just "echo present/absent":
   - **Reuse observed AND correctly deduplicated:** two `remote-track-observed` entries with the same `streamId` and different `connectionId`, followed by only one active entry in `remote-track-added` logs (the old one replaced, not duplicated) — and the echo is gone. This confirms the hypothesis and that the fix works.
   - **Reuse observed but NOT deduplicated:** the same same-`streamId`-different-`connectionId` pattern, but the echo is *still* present — this means the hypothesis was right but the fix has a bug (bring these exact log lines back for that follow-up, don't guess at a second fix).
   - **No reuse observed at all** (no same-`streamId`-different-`connectionId` pair anywhere in the sequence) — this means the echo (if still present) has a different cause than stream-id reuse across connections entirely, and this plan's fix doesn't address it; the `connection-state-changed` sequence (do connections transition through unexpected states, or never reach `"closed"` cleanly?) becomes the next thing to inspect, as a fresh investigation.
3. Confirm the `"treats the same stream id as the same logical source..."` behavior didn't break anything else noticeable — e.g. that a *second, genuinely different* participant joining mid-call is still heard (this is a different `stream.id`, so should be unaffected, but worth confirming with 2+ real participants if possible).

- [ ] **Step 4: Commit** (only if step 3 uncovers something that needs a follow-up fix; otherwise this task produces no code changes to commit)
