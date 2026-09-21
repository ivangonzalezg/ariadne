# Audio Mixer Lifecycle Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-specific override:** in this repo, tasks are delegated to and executed by the `codex:codex-rescue` agent (Codex), not by generic Claude subagents — see `CLAUDE.md`. Claude reviews each task's result against this plan before moving to the next one.

**Goal:** Fix the recorded-audio bug where the user's own mic sounds too quiet and other participants' audio sounds echoey/doubled, by making Asterion's WebRTC audio mixer correctly track the lifecycle of remote participants' audio (instead of only reacting to the `"ended"` event, which the WebRTC spec does not reliably fire when Google Meet renegotiates or replaces a participant's track), and by fixing a related bug where restarting a recording in the same tab leaks the previous microphone's audio node into the mix.

**Architecture:** Give every patched `RTCPeerConnection` a stable identity, and key each tracked remote audio source by `(connectionId, streamId-or-mid)` instead of a raw `track.id`. Listen to all four WebRTC lifecycle signals that actually matter (`ended`, `mute`, `unmute`, `removetrack`) instead of only `ended`, wire up the connection-close cleanup hook that has been a no-op since day one, and run a small periodic reconciliation sweep as a self-healing safety net for cases where none of those signals fire (this mirrors, at a reduced scope appropriate for this codebase, the pattern found in a decompiled competitor extension during this investigation — see the design discussion in this session; no code was copied, only the architectural pattern). `setMicTrack()` also gets fixed to disconnect the previous mic audio chain before creating a new one.

**Tech Stack:** Vanilla JS (WebRTC + Web Audio API), Vitest with hand-written fakes for `AudioContext`/`RTCPeerConnection`/`MediaStream` (none of these are implemented by `jsdom`, so tests fake only the handful of methods this code actually calls — see each task for the exact fakes).

**Context — how we got here:** The user reported quiet mic / echoey remote audio in both the mp3 and mp4 outputs, and later a related report that switching audio input/output devices mid-meeting (e.g., plugging in headphones) caused remote participants' audio to disappear entirely from the recording while the user's own mic kept recording fine. Investigation (documented in this session, not repeated here) found two confirmed bugs in `src/webrtc-bootstrap/`: (1) `rtc-patch.js`'s `onConnectionClosed` callback has been wired as a no-op in `bootstrap.js` since the file was first introduced, so remote audio sources are never cleaned up when their connection closes or fails; (2) `audio-mixer.js`'s `addRemoteTrack` only removes a source on the track's `"ended"` event, which per WebRTC spec does not reliably fire when a track is superseded during renegotiation (the old track becomes `muted` instead) — so stale/superseded remote sources keep contributing audio to the mix indefinitely, which explains both the "echo" (duplicate simultaneous copies of the same participant) and comparatively quiet mic (a single source competing against an ever-growing number of summed remote sources, with no gain normalization). A decompiled analysis of a competitor extension (Fireflies.ai, legitimately extracted from its public `.crx` package) confirmed they solve the identical class of problem with connection-scoped stream identity, all four lifecycle signals, and a periodic reconciliation sweep — this plan adopts that same general pattern, scoped down to this codebase's simpler single-mixer architecture (no multi-backend abstraction, no `getDisplayMedia` tab-audio mode, no `RTCRtpSender.replaceTrack` interception, none of which apply here — see the design discussion for why each was excluded). No special-case handling was added for the specific "device switch" scenario: neither our analysis nor the competitor's code has device-change-specific logic, and the general lifecycle-tracking fix below is expected to cover it as a side effect, which the diagnostic logging added here will let us confirm the next time it's reproduced.

---

## File Structure

- Modify: `src/webrtc-bootstrap/rtc-patch.js` — give each patched `RTCPeerConnection` a stable connection id, pass richer track-event payload (`stream`, `mid`, `connectionId`) to `onRemoteAudioTrack`, bail out of the `"track"` handler if the connection is already closed/failed, pass `connectionId` to `onConnectionClosed`.
- Modify: `src/webrtc-bootstrap/audio-mixer.js` — replace the `track.id`-keyed remote-source map with a connection-scoped one, add `mute`/`unmute`/`removetrack` handling alongside `ended`, add `removeConnection(connectionId)`, add a periodic `reconcile()` sweep with `startReconciliation()`/`stopReconciliation()`, fix `setMicTrack()` to disconnect the previous mic chain, make the `AudioContext` injectable for testing.
- Modify: `src/webrtc-bootstrap/bootstrap.js` — wire the new `onRemoteAudioTrack` payload straight into `mixer.addRemoteTrack(...)`, implement `onConnectionClosed` for real (was a no-op), start/stop reconciliation with the recording session, wire mixer diagnostic logs to `console.debug`.
- Test: `src/webrtc-bootstrap/rtc-patch.test.js` (new — this file currently has zero test coverage).
- Test: `src/webrtc-bootstrap/audio-mixer.test.js` (new — this file currently has zero test coverage).

## Key design decisions (for reference while implementing)

- **Remote-source identity:** `${connectionId}:${stream?.id ?? mid ?? track.id}` — connection-scoped because the mixer can receive tracks from multiple `RTCPeerConnection`s over a session, so a bare `stream.id` alone isn't guaranteed unique; `stream.id` is preferred over `mid` because it's what the competitor's approach validated works with Google Meet's SFU in practice, with `mid` and finally raw `track.id` as fallbacks for the rarer case where `event.streams` is empty.
- **On a new track arriving for a key that's already tracked with a *different* track object:** replace (disconnect the old source, connect the new one) — this is what happens when Meet renegotiates a slot with a new track. Same track object arriving again for the same key is a no-op (defends against duplicate event delivery).
- **`mute`/`unmute` don't immediately disconnect/reconnect anything** — `mute` just timestamps the source as "possibly going stale"; `unmute` clears that timestamp. This keeps the state machine simple (a source is always either fully tracked-and-connected, or not tracked at all — never "tracked but temporarily disconnected"), while still letting the reconciliation sweep purge a source that's been muted far longer than a normal mute action would ever last.
- **Reconciliation sweep (`reconcile()`):** runs every 5s while a recording session is active. For every tracked remote source: if its track's `readyState !== "live"`, purge it (this is the safety net for missed `"ended"` events). If it's been muted longer than 15s, purge it too (this is the safety net for the renegotiation-leaves-old-track-muted-forever case). Both thresholds are plain constants at the top of `audio-mixer.js`, easy to tune later. **Neither number is measured from real Meet traffic** — they're starting estimates (15s is meant to comfortably outlast a normal "I muted myself for a second" action; 5s keeps the sweep cheap without adding much latency on top of the 15s threshold). If the diagnostic logging added in this plan later shows a legitimately-muted participant getting purged too eagerly (or a stale source lingering too long), tune `MUTE_STALE_THRESHOLD_MS`/`RECONCILE_INTERVAL_MS` rather than redesigning the mechanism.
- **`connectionsClosed` diagnostic counter is not a count of unique connections** (Codex flagged this): a real `RTCPeerConnection` can transition `failed` → `closed`, firing `onConnectionClosed` twice for the same connection. `removeConnection()` itself is idempotent (a second call finds no keys left and no-ops), so this doesn't cause a correctness bug — it just means `diagnostics.connectionsClosed` is a count of *close/fail events*, not distinct connections, which matters only if that counter is ever used for user-facing reporting later.
- **Why not `RTCRtpSender.replaceTrack` interception for the mic:** that solves Meet swapping the *outgoing* mic track mid-call, which this codebase doesn't currently observe (our `getUserMedia` patch only updates a module-level variable; the mixer's mic node is set up once per recording session, not resynced against later `getUserMedia`/`replaceTrack` calls). The actual mic bug here — `setMicTrack()` leaking the previous mic node when called again in the same tab — has a much simpler direct fix (disconnect before replacing), which this plan implements. If a future report shows Meet swapping the live outgoing mic track *during* an active recording, that's a separate, new investigation.
- **Why not the `getDisplayMedia` tab-audio-capture approach:** the competitor's own code has that path force-disabled behind a feature flag because it's broken in their production. Not worth the complexity/risk here without stronger evidence it's actually better.

---

### Task 1: Give patched peer connections a stable identity and richer track-event payload

**Files:**
- Modify: `src/webrtc-bootstrap/rtc-patch.js`
- Test: `src/webrtc-bootstrap/rtc-patch.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/webrtc-bootstrap/rtc-patch.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function fakeAudioTrack(id) {
  return { kind: "audio", id };
}

let originalRTCPeerConnection;

beforeEach(() => {
  originalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = FakePeerConnection;
});

afterEach(() => {
  window.RTCPeerConnection = originalRTCPeerConnection;
  vi.restoreAllMocks();
});

describe("installRtcPatch", () => {
  it("increments diagnostics.peerConnectionsCreated for each new connection", async () => {
    vi.resetModules();
    const { installRtcPatch, diagnostics } = await import("./rtc-patch.js");
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    new window.RTCPeerConnection();
    new window.RTCPeerConnection();
    expect(diagnostics.peerConnectionsCreated).toBe(2);
  });

  it("calls onRemoteAudioTrack with track, stream, mid and a connectionId for an audio track event", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    const track = fakeAudioTrack("track-1");
    const stream = { id: "stream-1" };
    pc._emit("track", { track, streams: [stream], transceiver: { mid: "0" } });

    expect(onRemoteAudioTrack).toHaveBeenCalledTimes(1);
    const payload = onRemoteAudioTrack.mock.calls[0][0];
    expect(payload.track).toBe(track);
    expect(payload.stream).toBe(stream);
    expect(payload.mid).toBe("0");
    expect(typeof payload.connectionId).toBe("number");
  });

  it("ignores non-audio tracks", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc._emit("track", { track: { kind: "video", id: "v1" }, streams: [], transceiver: null });
    expect(onRemoteAudioTrack).not.toHaveBeenCalled();
  });

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

  it("passes null for stream/mid when the track event has neither", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc = new window.RTCPeerConnection();
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    const payload = onRemoteAudioTrack.mock.calls[0][0];
    expect(payload.stream).toBeNull();
    expect(payload.mid).toBeNull();
  });

  it("calls onConnectionClosed with the same connectionId the track events used, when the connection closes", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    const onConnectionClosed = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed });
    const pc = new window.RTCPeerConnection();
    pc._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    const { connectionId } = onRemoteAudioTrack.mock.calls[0][0];

    pc._setConnectionState("closed");

    expect(onConnectionClosed).toHaveBeenCalledWith(connectionId);
  });

  it("calls onConnectionClosed when the connection fails", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onConnectionClosed = vi.fn();
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed });
    const pc = new window.RTCPeerConnection();
    pc._setConnectionState("failed");
    expect(onConnectionClosed).toHaveBeenCalledTimes(1);
  });

  it("does not call onConnectionClosed for other connection states", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onConnectionClosed = vi.fn();
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed });
    const pc = new window.RTCPeerConnection();
    pc._setConnectionState("connected");
    pc._setConnectionState("disconnected");
    expect(onConnectionClosed).not.toHaveBeenCalled();
  });

  it("assigns a different connectionId to a different peer connection", async () => {
    vi.resetModules();
    const { installRtcPatch } = await import("./rtc-patch.js");
    const onRemoteAudioTrack = vi.fn();
    installRtcPatch({ onRemoteAudioTrack, onConnectionClosed: () => {} });
    const pc1 = new window.RTCPeerConnection();
    const pc2 = new window.RTCPeerConnection();
    pc1._emit("track", { track: fakeAudioTrack("t1"), streams: [], transceiver: null });
    pc2._emit("track", { track: fakeAudioTrack("t2"), streams: [], transceiver: null });
    const [{ connectionId: id1 }] = onRemoteAudioTrack.mock.calls[0];
    const [{ connectionId: id2 }] = onRemoteAudioTrack.mock.calls[1];
    expect(id1).not.toBe(id2);
  });
});

describe("installGetUserMediaPatch", () => {
  it("calls onMicStream with the stream and audio track when audio is requested", async () => {
    vi.resetModules();
    const { installGetUserMediaPatch } = await import("./rtc-patch.js");
    const audioTrack = fakeAudioTrack("mic-1");
    const stream = { getAudioTracks: () => [audioTrack] };
    const originalGetUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });

    const onMicStream = vi.fn();
    installGetUserMediaPatch({ onMicStream });

    const result = await navigator.mediaDevices.getUserMedia({ audio: true });

    expect(result).toBe(stream);
    expect(onMicStream).toHaveBeenCalledWith(stream, audioTrack);
  });

  it("does not call onMicStream when the constraints have no audio", async () => {
    vi.resetModules();
    const { installGetUserMediaPatch } = await import("./rtc-patch.js");
    const stream = { getAudioTracks: () => [] };
    const originalGetUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });

    const onMicStream = vi.fn();
    installGetUserMediaPatch({ onMicStream });

    await navigator.mediaDevices.getUserMedia({ video: true });

    expect(onMicStream).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/webrtc-bootstrap/rtc-patch.test.js`
Expected: FAIL — several tests fail because `onRemoteAudioTrack` is currently called with just `(track, pc)` (no `stream`/`mid`/`connectionId` payload shape), `onConnectionClosed` is currently called with the raw `pc` object (not a `connectionId`), and there's no early-return guard for an already-closed connection.

- [ ] **Step 3: Implement the changes**

Replace the full contents of `src/webrtc-bootstrap/rtc-patch.js` with:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/webrtc-bootstrap/rtc-patch.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/rtc-patch.js src/webrtc-bootstrap/rtc-patch.test.js
git commit -m "feat: give patched peer connections a stable identity for audio lifecycle tracking"
```

---

### Task 2: Rewrite the audio mixer's remote-source lifecycle tracking

**Files:**
- Modify: `src/webrtc-bootstrap/audio-mixer.js`
- Test: `src/webrtc-bootstrap/audio-mixer.test.js`

- [ ] **Step 1: Write the failing tests**

`AudioContext`/`MediaStream` aren't implemented by `jsdom`, and this class currently hardcodes `new AudioContext()` in its constructor. This step also makes the `AudioContext` injectable (a plain options-object parameter, matching the style already used by `MainWorldSession`'s constructor in `src/webrtc-bootstrap/session.js`) so it can be faked in tests — this is a **testability change**, not a behavior change: `new MeetingAudioMixer()` with no arguments still creates a real `AudioContext`, exactly as before.

Create `src/webrtc-bootstrap/audio-mixer.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { MeetingAudioMixer } from "./audio-mixer.js";

// jsdom doesn't implement MediaStream at all. audio-mixer.js's addRemoteTrack
// and setMicTrack both do `new MediaStream([track])` for real (the fake
// AudioContext below only fakes the AudioContext methods, not MediaStream
// itself) — without this stub every test that reaches those lines throws
// "MediaStream is not defined".
class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
}
globalThis.MediaStream = FakeMediaStream;

function fakeTrack(id, { readyState = "live" } = {}) {
  const listeners = {};
  return {
    id,
    readyState,
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    _emit(type) {
      (listeners[type] || []).forEach((handler) => handler());
    },
    _setReadyState(state) {
      this.readyState = state;
    },
  };
}

function fakeStream(id) {
  const listeners = {};
  return {
    id,
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    _emit(type, detail) {
      (listeners[type] || []).forEach((handler) => handler(detail));
    },
  };
}

function fakeAudioContext() {
  const sourceNodes = [];
  const gainNodes = [];
  const context = {
    state: "running",
    currentTime: 0,
    createMediaStreamDestination: () => ({ stream: {} }),
    createMediaStreamSource: () => {
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      sourceNodes.push(node);
      return node;
    },
    createGain: () => {
      const node = {
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gainNodes.push(node);
      return node;
    },
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { context, sourceNodes, gainNodes };
}

function makeMixer(overrides = {}) {
  const { context, sourceNodes, gainNodes } = fakeAudioContext();
  let currentNow = 0;
  const mixer = new MeetingAudioMixer({
    audioContext: context,
    now: () => currentNow,
    log: () => {},
    ...overrides,
  });
  return { mixer, sourceNodes, gainNodes, advanceNow: (ms) => { currentNow += ms; } };
}

describe("MeetingAudioMixer remote sources", () => {
  it("connects a new remote track to the destination", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0].connect).toHaveBeenCalledTimes(1);
  });

  it("does not add a duplicate entry for the exact same track object", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("t1");
    const stream = fakeStream("s1");
    mixer.addRemoteTrack({ track, stream, mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track, stream, mid: null, connectionId: 1 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes).toHaveLength(1);
  });

  it("replaces the source when a new track arrives for the same connection+stream slot", () => {
    const { mixer, sourceNodes } = makeMixer();
    const stream = fakeStream("s1");
    const firstTrack = fakeTrack("t1");
    const secondTrack = fakeTrack("t2");
    mixer.addRemoteTrack({ track: firstTrack, stream, mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: secondTrack, stream, mid: null, connectionId: 1 });

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
  });

  it("ignores a late lifecycle event from a track that was already replaced", () => {
    // Regression test for a real bug Codex's review caught in an earlier version
    // of this plan: the old track's "ended"/"mute"/"unmute" listeners closed
    // over `key`, not over the specific track they were attached for — so a
    // late-firing event from the REPLACED track would incorrectly tear down or
    // stale-mark the NEW track's entry, since both live at the same key.
    const { mixer, sourceNodes } = makeMixer();
    const stream = fakeStream("s1");
    const firstTrack = fakeTrack("t1");
    const secondTrack = fakeTrack("t2");
    mixer.addRemoteTrack({ track: firstTrack, stream, mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: secondTrack, stream, mid: null, connectionId: 1 });

    firstTrack._emit("ended");
    firstTrack._emit("mute");

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();

    // The new (second) track's own events must still work normally.
    secondTrack._emit("ended");
    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("keeps sources from different connections separate even with the same stream id", () => {
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s1"), mid: null, connectionId: 2 });

    expect(mixer.activeRemoteSourceCount).toBe(2);
  });

  it("removes a source when its track fires ended", () => {
    const { mixer, sourceNodes } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._emit("ended");

    expect(mixer.activeRemoteSourceCount).toBe(0);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("removes a source when its stream fires removetrack for that track", () => {
    const { mixer } = makeMixer();
    const track = fakeTrack("t1");
    const stream = fakeStream("s1");
    mixer.addRemoteTrack({ track, stream, mid: null, connectionId: 1 });

    stream._emit("removetrack", { track });

    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("removes every source that belongs to a connection when removeConnection is called", () => {
    const { mixer, sourceNodes } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t2"), stream: fakeStream("s2"), mid: null, connectionId: 1 });
    mixer.addRemoteTrack({ track: fakeTrack("t3"), stream: fakeStream("s3"), mid: null, connectionId: 2 });

    mixer.removeConnection(1);

    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[2].disconnect).not.toHaveBeenCalled();
  });

  it("reconcile purges a source whose track is no longer live, even if ended never fired", () => {
    const { mixer } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._setReadyState("ended");
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("reconcile does not purge a live, unmuted source", () => {
    const { mixer } = makeMixer();
    mixer.addRemoteTrack({ track: fakeTrack("t1"), stream: fakeStream("s1"), mid: null, connectionId: 1 });

    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(1);
  });

  it("reconcile purges a source that has been muted longer than the stale threshold", () => {
    const { mixer, advanceNow } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._emit("mute");
    advanceNow(16000);
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(0);
  });

  it("reconcile does not purge a source that unmuted before the stale threshold", () => {
    const { mixer, advanceNow } = makeMixer();
    const track = fakeTrack("t1");
    mixer.addRemoteTrack({ track, stream: fakeStream("s1"), mid: null, connectionId: 1 });

    track._emit("mute");
    advanceNow(1000);
    track._emit("unmute");
    advanceNow(16000);
    mixer.reconcile();

    expect(mixer.activeRemoteSourceCount).toBe(1);
  });
});

describe("MeetingAudioMixer reconciliation scheduling", () => {
  it("starts and stops a periodic call to reconcile", () => {
    vi.useFakeTimers();
    try {
      const { mixer } = makeMixer();
      const reconcileSpy = vi.spyOn(mixer, "reconcile");

      mixer.startReconciliation(1000);
      vi.advanceTimersByTime(3500);
      expect(reconcileSpy).toHaveBeenCalledTimes(3);

      mixer.stopReconciliation();
      vi.advanceTimersByTime(5000);
      expect(reconcileSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calling startReconciliation twice does not schedule a second interval", () => {
    vi.useFakeTimers();
    try {
      const { mixer } = makeMixer();
      const reconcileSpy = vi.spyOn(mixer, "reconcile");

      mixer.startReconciliation(1000);
      mixer.startReconciliation(1000);
      vi.advanceTimersByTime(1000);

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MeetingAudioMixer mic lifecycle", () => {
  it("disconnects the previous mic chain when setMicTrack is called again", () => {
    const { mixer, sourceNodes, gainNodes } = makeMixer();
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });
    mixer.setMicTrack(fakeTrack("mic-2"), { initiallyMuted: false });

    expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(gainNodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sourceNodes[1].disconnect).not.toHaveBeenCalled();
    expect(gainNodes[1].disconnect).not.toHaveBeenCalled();
  });

  it("does not throw when setMicTrack is called for the first time", () => {
    const { mixer } = makeMixer();
    expect(() => mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/webrtc-bootstrap/audio-mixer.test.js`
Expected: FAIL — `MeetingAudioMixer`'s constructor doesn't accept an `audioContext` override yet, `addRemoteTrack` has a different signature (`(track)` instead of `({ track, stream, mid, connectionId })`), and `activeRemoteSourceCount`, `removeConnection`, `reconcile`, `startReconciliation`, `stopReconciliation` don't exist yet.

- [ ] **Step 3: Implement the changes**

Replace the full contents of `src/webrtc-bootstrap/audio-mixer.js` with:

```js
// src/webrtc-bootstrap/audio-mixer.js
const MUTE_STALE_THRESHOLD_MS = 15000;
const RECONCILE_INTERVAL_MS = 5000;

export class MeetingAudioMixer {
  constructor({ audioContext = new AudioContext(), now = () => Date.now(), log = () => {} } = {}) {
    this.audioContext = audioContext;
    this.destination = this.audioContext.createMediaStreamDestination();
    // key -> { connectionId, sourceNode, track, staleSince }
    this.remoteSources = new Map();
    // connectionId -> Set<key>, for O(1) purge-by-connection
    this.connectionKeys = new Map();
    this.micSourceNode = null;
    this.micGainNode = null;
    this.reconcileTimer = null;
    this.now = now;
    this.log = log;
  }

  get activeRemoteSourceCount() {
    return this.remoteSources.size;
  }

  _remoteKey(connectionId, { streamId, mid, track }) {
    return `${connectionId}:${streamId ?? mid ?? track.id}`;
  }

  addRemoteTrack({ track, stream, mid, connectionId }) {
    const key = this._remoteKey(connectionId, { streamId: stream?.id ?? null, mid, track });
    const existing = this.remoteSources.get(key);
    if (existing && existing.track === track) return;
    if (existing) this._teardownEntry(key, existing, "replaced by a newer track for the same slot");

    // Siempre envolvemos solo este track en su propio MediaStream — nunca usamos
    // `stream` (el MediaStream completo del evento) directamente acá, porque si
    // ese stream tuviera más de un track, createMediaStreamSource podría tomar
    // uno distinto al que realmente nos interesa. `stream` se usa únicamente
    // como identidad (su .id) y para el listener de "removetrack" más abajo.
    const sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([track]));
    sourceNode.connect(this.destination);

    const entry = { connectionId, sourceNode, track, staleSince: null };
    this.remoteSources.set(key, entry);

    let keysForConnection = this.connectionKeys.get(connectionId);
    if (!keysForConnection) {
      keysForConnection = new Set();
      this.connectionKeys.set(connectionId, keysForConnection);
    }
    keysForConnection.add(key);

    // Cada listener valida que la entrada en `key` siga siendo ESTE `track`
    // antes de actuar. Sin esa validación, si este track es reemplazado (ver
    // el `_teardownEntry` de arriba) pero el track viejo sigue vivo un rato y
    // dispara "ended"/"mute"/"unmute" más tarde, esos listeners viejos
    // encontrarían la entrada NUEVA en `this.remoteSources.get(key)` (misma
    // key) y la purgarían/marcarían por error — un bug real que la revisión
    // de Codex encontró en una versión anterior de este mismo plan.
    track.addEventListener("ended", () => {
      if (this.remoteSources.get(key)?.track === track) this._removeRemoteSource(key, "track ended");
    });
    track.addEventListener("mute", () => {
      if (this.remoteSources.get(key)?.track === track) this._markStale(key);
    });
    track.addEventListener("unmute", () => {
      if (this.remoteSources.get(key)?.track === track) this._clearStale(key);
    });
    stream?.addEventListener("removetrack", (event) => {
      if (event.track === track && this.remoteSources.get(key)?.track === track) {
        this._removeRemoteSource(key, "removed from its MediaStream");
      }
    });

    this.log("remote-track-added", { key, connectionId, streamId: stream?.id ?? null, mid, trackId: track.id });
  }

  removeConnection(connectionId) {
    const keys = this.connectionKeys.get(connectionId);
    if (!keys) return;
    for (const key of [...keys]) this._removeRemoteSource(key, "connection closed");
    this.connectionKeys.delete(connectionId);
  }

  reconcile() {
    const now = this.now();
    for (const [key, entry] of [...this.remoteSources]) {
      if (entry.track.readyState !== "live") {
        this._removeRemoteSource(key, "reconcile: track not live");
        continue;
      }
      if (entry.staleSince !== null && now - entry.staleSince > MUTE_STALE_THRESHOLD_MS) {
        this._removeRemoteSource(key, "reconcile: muted too long");
      }
    }
  }

  startReconciliation(intervalMs = RECONCILE_INTERVAL_MS) {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => this.reconcile(), intervalMs);
  }

  stopReconciliation() {
    if (!this.reconcileTimer) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  _markStale(key) {
    const entry = this.remoteSources.get(key);
    if (!entry) return;
    entry.staleSince = this.now();
    this.log("remote-track-muted", { key });
  }

  _clearStale(key) {
    const entry = this.remoteSources.get(key);
    if (!entry) return;
    entry.staleSince = null;
    this.log("remote-track-unmuted", { key });
  }

  _removeRemoteSource(key, reason) {
    const entry = this.remoteSources.get(key);
    if (!entry) return;
    this._teardownEntry(key, entry, reason);
  }

  _teardownEntry(key, entry, reason) {
    try {
      entry.sourceNode.disconnect();
    } catch {
      // ya pudo haber sido desconectado
    }
    this.remoteSources.delete(key);
    const keysForConnection = this.connectionKeys.get(entry.connectionId);
    if (keysForConnection) {
      keysForConnection.delete(key);
      // El mixer vive toda la pestaña y nunca se cierra entre sesiones — si no
      // borramos los Sets vacíos acá, connectionKeys crece sin límite a lo
      // largo de una reunión larga con muchas reconexiones.
      if (keysForConnection.size === 0) this.connectionKeys.delete(entry.connectionId);
    }
    this.log("remote-track-removed", { key, reason });
  }

  setMicTrack(micTrack, { initiallyMuted }) {
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch {
        // ya pudo haber sido desconectado
      }
    }
    if (this.micGainNode) {
      try {
        this.micGainNode.disconnect();
      } catch {
        // ya pudo haber sido desconectado
      }
    }

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

  async resume() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  async close() {
    this.stopReconciliation();
    await this.audioContext.close();
  }
}
```

Note: `addRemoteTrack` always calls `new MediaStream([track])` — it never passes the event's own `stream` straight into `createMediaStreamSource`, even when a `stream` is available. This matters: `stream` (the whole `MediaStream` from the WebRTC `track` event) could in principle contain more than one track, and `createMediaStreamSource` on a multi-track stream isn't guaranteed to pick the specific track this code is trying to mix in — so `stream` is used only for its `.id` (part of the mixer key) and to attach the `"removetrack"` listener, never as the actual audio source. `setMicTrack` does the same `new MediaStream([micTrack])` it always did. Both of these hit the real global `MediaStream` constructor, which `jsdom` doesn't implement — that's why this test file defines and installs `FakeMediaStream` as `globalThis.MediaStream` right after its imports, before any test runs. Without that stub, every test that calls `addRemoteTrack` or `setMicTrack` would throw `MediaStream is not defined`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/webrtc-bootstrap/audio-mixer.test.js`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/audio-mixer.js src/webrtc-bootstrap/audio-mixer.test.js
git commit -m "fix: track remote audio sources by connection+stream and self-heal via mute/unmute/removetrack/reconcile"
```

---

### Task 3: Wire bootstrap.js to the new mixer/rtc-patch APIs

**Files:**
- Modify: `src/webrtc-bootstrap/bootstrap.js`

- [ ] **Step 1: Update bootstrap.js**

In `src/webrtc-bootstrap/bootstrap.js`, change:

```js
console.log("[Asterion:debug] bootstrap (MAIN world) cargado");

const mixer = new MeetingAudioMixer();
mixer.resume().catch(() => {});
let micTrack = null;
let session = null;

installRtcPatch({
  onRemoteAudioTrack: (track) => mixer.addRemoteTrack(track),
  onConnectionClosed: () => {},
});
```

to:

```js
console.log("[Asterion:debug] bootstrap (MAIN world) cargado");

const mixer = new MeetingAudioMixer({
  log: (event, details) => console.debug(`[Asterion:audio-mixer] ${event}`, details),
});
mixer.resume().catch(() => {});
let micTrack = null;
let session = null;

installRtcPatch({
  onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
  onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
});
```

Then, in the `asterion:start-session` handler, start reconciliation once the session is running. Change:

```js
    session = new MainWorldSession({
      sessionId: message.sessionId,
      mixer,
      postToIsolated,
      initialMicMuted: Boolean(message.initialMicMuted),
    });
    session.start();
    postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });
```

to:

```js
    session = new MainWorldSession({
      sessionId: message.sessionId,
      mixer,
      postToIsolated,
      initialMicMuted: Boolean(message.initialMicMuted),
    });
    session.start();
    mixer.startReconciliation();
    postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });
```

Then, in the `asterion:stop-session` handler, stop reconciliation. Change:

```js
  } else if (message.type === "asterion:stop-session") {
    session?.stop();
    session = null;
  }
```

to:

```js
  } else if (message.type === "asterion:stop-session") {
    session?.stop();
    session = null;
    mixer.stopReconciliation();
  }
```

The rest of `bootstrap.js` (the `getUserMedia` patch wiring, the `data-asterion-enable-video` click handler, `window.__asterionDiagnostics`) is unchanged.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — `bootstrap.js` has no dedicated unit tests (it's a thin wiring/orchestration file that talks to `window`/`chrome`/DOM click events, matching this file's existing untested status), so this step just confirms Task 1 and Task 2's changes didn't break anything else and that `bootstrap.js`'s call sites now match the new `addRemoteTrack`/`removeConnection` signatures without any lint/type errors surfacing through the build in the next step.

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: succeeds — confirms `bootstrap.js` (bundled into `dist/webrtc-bootstrap.bundle.js`) still compiles cleanly with the updated call sites.

- [ ] **Step 4: Commit**

```bash
git add src/webrtc-bootstrap/bootstrap.js
git commit -m "fix: wire real connection-close cleanup and reconciliation scheduling into the audio mixer"
```

---

### Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: PASS, all suites green (including the 11 new `rtc-patch.test.js` tests and the 16 new `audio-mixer.test.js` tests — 27 new tests total, on two files that had zero coverage before this plan).

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Manual verification (report what could and couldn't be checked)**

This needs a real multi-participant Google Meet call, which can't be reproduced from this environment — report explicitly which of these were actually checked versus skipped:
1. Record a meeting with at least 2 other participants talking for several minutes; confirm in the resulting mp3/mp4 that no one's voice sounds echoey/doubled, and that your own mic is at a comparable volume to the others.
2. Mid-recording, have another participant mute and unmute themselves a few times; confirm their audio continues normally afterward (this exercises the `mute`/`unmute` handling and confirms it doesn't wrongly purge a briefly-muted participant).
3. Mid-recording, switch your own audio input/output device (e.g., plug in headphones or a Bluetooth headset), continue the meeting for a few more minutes, and confirm other participants' audio is still present in the recording afterward (this is the specific scenario the user reported; there's no dedicated code path for it, so this step is what actually confirms whether the general lifecycle fix covers it).
4. Open the page's DevTools console during a recording and confirm `[Asterion:audio-mixer]` log lines appear for `remote-track-added` when participants join/speak, and (if step 3 is performed) for `remote-track-removed`/reconcile-triggered removals around the device switch — this is the diagnostic logging that will make it possible to pin down the exact mechanism if the bug is *not* fully resolved by this fix, without needing another blind investigation.

- [ ] **Step 4: Commit** (only if step 3 uncovers something that needs a follow-up fix; otherwise this task produces no code changes to commit)
