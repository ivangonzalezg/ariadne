# Audio Mixer Stereo Channel Configuration Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-specific override:** in this repo, tasks are delegated to and executed by the `codex:codex-rescue` agent (Codex), not by generic Claude subagents — see `CLAUDE.md`. Claude reviews each task's result against this plan before moving to the next one.

**Goal:** Investigate and take a first, low-risk pass at a reported bug where, after the previous audio-mixer lifecycle fix (see `docs/superpowers/plans/2026-09-21-audio-mixer-lifecycle-fix.md`, already shipped), the recording user's own microphone plays back only on the left audio channel — right channel silent — while other participants' audio plays correctly on both channels. **This plan does not claim to definitively fix the bug** — see "Why this fix, revised after Codex's review" below. It adds targeted diagnostic logging (so the next reproduction gives real evidence instead of another round of spec-reasoning) and applies a cheap, harmless hardening change Codex confirmed is worth keeping regardless.

**Architecture:** Add diagnostic logging of the mic track's own reported channel count and of the destination/mic-gain nodes' channel configuration both before and after this task's changes. Also explicitly force `channelCount = 2`, `channelCountMode = "explicit"`, `channelInterpretation = "speakers"` on the mixer's `MediaStreamAudioDestinationNode` and on the per-recording `GainNode` the mic signal passes through, instead of relying on their default values — understanding that the destination likely already defaults to this configuration, so this part is defensive hardening, not a confirmed repair.

**Tech Stack:** Same as the parent lifecycle fix — vanilla JS Web Audio API, Vitest with the hand-written `AudioContext` fakes already in `src/webrtc-bootstrap/audio-mixer.test.js`.

**Context — how we got here:** After shipping the connection/track lifecycle fix, the user reported the echo/quiet-mic bug improved, but found a new (or newly-noticeable) issue: their own mic is audible only through the left speaker in both the mp3 and mp4 outputs, while remote participants sound correct in both channels. Investigation (this session) compared our code against a decompiled comparable extension again, specifically for channel-handling code — they don't do anything special either (no `channelCount`/`channelInterpretation` configuration anywhere in their bundle); their local mic and remote-participant audio both connect with a plain `createMediaStreamSource(stream).connect(destination)`, no intermediate `GainNode`. That's the one real structural difference from our code: our mic path routes through an extra `GainNode` (used to implement the mute/unmute gain ramp — see `setMicMuted()`), while remote sources connect directly to the destination.

**Why this fix, revised after Codex's review (read this before trusting the fix alone):** The first version of this plan reasoned that `createMediaStreamDestination()`'s channel count might not reliably resolve to 2 at runtime, and that forcing it explicitly would fix a "speakers interpretation falls back to discrete for an undefined channel pair" failure mode. Codex's review corrected that: per spec, `MediaStreamAudioDestinationNode` **defaults** to `channelCount: 2`, `channelCountMode: "explicit"`, `channelInterpretation: "speakers"` already — it is not hardware/runtime-dependent the way the first version assumed. So explicitly forcing those same values on `this.destination` is very likely a **no-op** in practice, not a repair.

Codex's more plausible alternative, grounded directly in our code: `setMicTrack()` (`src/webrtc-bootstrap/audio-mixer.js:146-168`) just wraps whatever `MediaStreamTrack` Google Meet's own `getUserMedia` call produced (we only *intercept* that call in `rtc-patch.js`, we never set our own audio constraints on it). If that track is itself already reporting 2 channels with real audio only in channel 0 (a real possibility on some hardware/driver setups, especially around a device switch — which this same user independently reported issues with earlier in this investigation), then every node it passes through is doing a 2-channel-to-2-channel pass-through the whole way — no up-mix ever happens, because the channel counts already match, and forcing `channelCount=2` on the `GainNode` changes nothing about *content* already silent on channel 1. If that's what's actually happening, the real fix isn't channel-count configuration at all — it would be an explicit fold-down/re-duplication stage (e.g. a `ChannelSplitterNode` pulling out channel 0 and a `ChannelMergerNode` duplicating it into both outputs), which this plan deliberately does **not** build yet, because we have no evidence it's needed.

Given that, this task does two things, in order of actual confidence:
1. **Diagnostics first** (the part we're confident is worth doing): log the mic track's own reported `channelCount` (via `MediaStreamTrack.getSettings()`), and log the destination/gain nodes' channel configuration **both before and after** this task's override — so the next time this bug is reproduced, the DevTools console gives real evidence to narrow down which theory is more likely, instead of reasoning from the spec blind. This logging alone doesn't prove anything about actual channel *content* (see Task 2's manual verification for what does).
2. **Force explicit stereo config on the destination and mic gain node anyway** (cheap, harmless hardening Codex explicitly recommended keeping) — but this plan does **not** claim this alone resolves the reported symptom. If the diagnostics from point 1 show the mic track itself already has `channelCount: 2` **and** the raw-recording inspection in Task 2 confirms channel 1 is genuinely silent at the source, this fix is confirmed insufficient and the next step is the fold-down/re-duplication approach described above, as a *new* plan informed by that evidence — not guessed at now.

---

## File Structure

- Modify: `src/webrtc-bootstrap/audio-mixer.js` — add a `_forceStereoChannelConfig(node, label)` helper that logs the node's channel config before and after forcing it to explicit stereo, call it on `this.destination` right after creating it in the constructor and on `this.micGainNode` right after creating it in `setMicTrack()`, and log the mic track's own reported `channelCount` (via `MediaStreamTrack.getSettings()`) at the top of `setMicTrack()`.
- Modify: `src/webrtc-bootstrap/audio-mixer.test.js` — extend the existing `fakeAudioContext()`/`makeMixer()`/`fakeTrack()` test helpers (already in this file, committed in the previous plan) to expose the fake destination node and a fake `getSettings()`, and add a new `describe("MeetingAudioMixer channel configuration", ...)` block.

---

### Task 1: Add channel-config diagnostics and force explicit stereo as defensive hardening

**Files:**
- Modify: `src/webrtc-bootstrap/audio-mixer.js`
- Modify: `src/webrtc-bootstrap/audio-mixer.test.js`

- [ ] **Step 1: Write the failing tests**

In `src/webrtc-bootstrap/audio-mixer.test.js`, the existing `fakeAudioContext()` helper's `createMediaStreamDestination` currently returns a fresh untracked object each time (`() => ({ stream: {} })`), so tests can't inspect the destination node it created. Change it to track that node, the same way `createMediaStreamSource`/`createGain` already track `sourceNodes`/`gainNodes`.

Change:
```js
function fakeAudioContext() {
  const sourceNodes = [];
  const gainNodes = [];
  const context = {
    state: "running",
    currentTime: 0,
    createMediaStreamDestination: () => ({ stream: {} }),
    createMediaStreamSource: () => {
```
to:
```js
function fakeAudioContext() {
  const sourceNodes = [];
  const gainNodes = [];
  let destinationNode = null;
  const context = {
    state: "running",
    currentTime: 0,
    createMediaStreamDestination: () => {
      destinationNode = { stream: {} };
      return destinationNode;
    },
    createMediaStreamSource: () => {
```

Then change the end of the same function. Change:
```js
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { context, sourceNodes, gainNodes };
}
```
to:
```js
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { context, sourceNodes, gainNodes, get destinationNode() { return destinationNode; } };
}
```

Then update `makeMixer()` to surface the destination node too. Change:
```js
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
```
to:
```js
function makeMixer(overrides = {}) {
  const audioContextFake = fakeAudioContext();
  const { context, sourceNodes, gainNodes } = audioContextFake;
  let currentNow = 0;
  const mixer = new MeetingAudioMixer({
    audioContext: context,
    now: () => currentNow,
    log: () => {},
    ...overrides,
  });
  return {
    mixer,
    sourceNodes,
    gainNodes,
    destinationNode: audioContextFake.destinationNode,
    advanceNow: (ms) => { currentNow += ms; },
  };
}
```

(`destinationNode` is captured as a plain value here, not a live getter — by the time `new MeetingAudioMixer(...)` returns on the line above, the constructor has already synchronously called `createMediaStreamDestination()` once, so the value is already set.)

The existing `fakeTrack()` helper doesn't implement `getSettings()`, which `setMicTrack()` now calls to log the mic track's own reported channel count. Change:

```js
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
```

to:

```js
function fakeTrack(id, { readyState = "live", channelCount = null } = {}) {
  const listeners = {};
  return {
    id,
    readyState,
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    getSettings() {
      return { channelCount };
    },
    _emit(type) {
      (listeners[type] || []).forEach((handler) => handler());
    },
    _setReadyState(state) {
      this.readyState = state;
    },
  };
}
```

(Every pre-existing call to `fakeTrack("some-id")` still works unchanged — `channelCount` defaults to `null`, matching what real code sees for a track that doesn't report it.)

Then add a new `describe` block anywhere after the existing ones (e.g. at the end of the file):

```js
describe("MeetingAudioMixer channel configuration", () => {
  it("forces the destination node to explicit stereo", () => {
    const { destinationNode } = makeMixer();
    expect(destinationNode.channelCount).toBe(2);
    expect(destinationNode.channelCountMode).toBe("explicit");
    expect(destinationNode.channelInterpretation).toBe("speakers");
  });

  it("forces the mic gain node to explicit stereo so a mono mic up-mixes to both channels", () => {
    const { mixer, gainNodes } = makeMixer();
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });

    expect(gainNodes[0].channelCount).toBe(2);
    expect(gainNodes[0].channelCountMode).toBe("explicit");
    expect(gainNodes[0].channelInterpretation).toBe("speakers");
  });

  it("re-applies explicit stereo to the new mic gain node when setMicTrack is called again", () => {
    const { mixer, gainNodes } = makeMixer();
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });
    mixer.setMicTrack(fakeTrack("mic-2"), { initiallyMuted: false });

    expect(gainNodes[1].channelCount).toBe(2);
    expect(gainNodes[1].channelCountMode).toBe("explicit");
    expect(gainNodes[1].channelInterpretation).toBe("speakers");
  });

  it("logs the destination's channel configuration before and after forcing it to stereo", () => {
    const logs = [];
    makeMixer({ log: (event, details) => logs.push({ event, details }) });

    expect(logs).toContainEqual({
      event: "mixer-channel-config-before",
      details: { node: "destination", channelCount: undefined, channelCountMode: undefined, channelInterpretation: undefined },
    });
    expect(logs).toContainEqual({ event: "mixer-channel-config-after", details: { node: "destination", channelCount: 2 } });
  });

  it("logs the mic track's own reported channel count separately from the gain node's forced config", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    mixer.setMicTrack(fakeTrack("mic-1", { channelCount: 2 }), { initiallyMuted: false });

    expect(logs).toContainEqual({ event: "mic-track-settings", details: { trackId: "mic-1", channelCount: 2 } });
    expect(logs).toContainEqual({ event: "mixer-channel-config-after", details: { node: "micGainNode", channelCount: 2 } });
  });

  it("logs the mic gain node's channel configuration before forcing it to stereo, same as the destination", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    mixer.setMicTrack(fakeTrack("mic-1"), { initiallyMuted: false });

    expect(logs).toContainEqual({
      event: "mixer-channel-config-before",
      details: { node: "micGainNode", channelCount: undefined, channelCountMode: undefined, channelInterpretation: undefined },
    });
  });

  it("logs a null channelCount when the mic track has no getSettings method at all", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    const trackWithoutGetSettings = fakeTrack("mic-1");
    delete trackWithoutGetSettings.getSettings;

    mixer.setMicTrack(trackWithoutGetSettings, { initiallyMuted: false });

    expect(logs).toContainEqual({ event: "mic-track-settings", details: { trackId: "mic-1", channelCount: null } });
  });

  it("logs a null channelCount when getSettings exists but returns undefined", () => {
    const logs = [];
    const { mixer } = makeMixer({ log: (event, details) => logs.push({ event, details }) });
    const trackWithEmptySettings = fakeTrack("mic-1");
    trackWithEmptySettings.getSettings = () => undefined;

    mixer.setMicTrack(trackWithEmptySettings, { initiallyMuted: false });

    expect(logs).toContainEqual({ event: "mic-track-settings", details: { trackId: "mic-1", channelCount: null } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/webrtc-bootstrap/audio-mixer.test.js`
Expected: FAIL — the eight new tests fail because `_forceStereoChannelConfig` doesn't exist yet, so the fake destination/gain nodes never get `channelCount`/`channelCountMode`/`channelInterpretation` set, and neither the `"mixer-channel-config-before"`/`"mixer-channel-config-after"` nor the `"mic-track-settings"` logs are ever emitted. The 16 pre-existing tests in this file should still pass (this step's test-helper changes are additive/refactor-only for them).

- [ ] **Step 3: Implement the fix**

In `src/webrtc-bootstrap/audio-mixer.js`, change the constructor. Change:

```js
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
```

to:

```js
  constructor({ audioContext = new AudioContext(), now = () => Date.now(), log = () => {} } = {}) {
    this.audioContext = audioContext;
    this.now = now;
    this.log = log;
    this.destination = this.audioContext.createMediaStreamDestination();
    this._forceStereoChannelConfig(this.destination, "destination");
    // key -> { connectionId, sourceNode, track, staleSince }
    this.remoteSources = new Map();
    // connectionId -> Set<key>, for O(1) purge-by-connection
    this.connectionKeys = new Map();
    this.micSourceNode = null;
    this.micGainNode = null;
    this.reconcileTimer = null;
  }

  // Fuerza explícitamente 2 canales (estéreo) en el nodo, en vez de confiar
  // en su configuración por defecto. NOTA (agregada tras la revisión de
  // Codex): por spec, MediaStreamAudioDestinationNode YA viene por defecto
  // con channelCount=2/channelCountMode="explicit"/channelInterpretation=
  // "speakers" — así que forzar esto en `destination` es casi seguro un
  // no-op, no una reparación confirmada. Lo mantenemos igual porque no
  // cuesta nada y Codex lo recomendó como hardening defensivo, pero NO debe
  // presentarse como "la solución" sin evidencia de un caso real donde el
  // valor por defecto haya sido distinto. Por eso este método loguea el
  // valor ANTES de pisarlo — es la evidencia real que nos falta hoy.
  _forceStereoChannelConfig(node, label) {
    this.log("mixer-channel-config-before", {
      node: label,
      channelCount: node.channelCount,
      channelCountMode: node.channelCountMode,
      channelInterpretation: node.channelInterpretation,
    });
    node.channelCount = 2;
    node.channelCountMode = "explicit";
    node.channelInterpretation = "speakers";
    this.log("mixer-channel-config-after", { node: label, channelCount: node.channelCount });
  }
```

(`this.now`/`this.log` are moved to the top of the constructor because `_forceStereoChannelConfig` calls `this.log(...)`, which must already be assigned by the time it's first called on the line right after.)

Then update `setMicTrack()` to log the mic track's own reported channel count (the diagnostic Codex specifically recommended — note what this does and doesn't prove: a reported `channelCount: 2` would rule out "the track is plainly mono," which is a necessary condition for the alternative "already-stereo, silent channel 1" theory, but it does NOT by itself prove channel 1 is actually silent — that needs the raw-recording inspection in Task 2's manual verification step) and apply the same hardening to the gain node. The log is inserted as the very first statement in the method, before the existing old-node teardown, so it reflects the incoming track's settings regardless of what happens afterward. Change the full method:

```js
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
```

to:

```js
  setMicTrack(micTrack, { initiallyMuted }) {
    this.log("mic-track-settings", {
      trackId: micTrack.id,
      channelCount: micTrack.getSettings?.()?.channelCount ?? null,
    });

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
    this._forceStereoChannelConfig(this.micGainNode, "micGainNode");
    this.micGainNode.gain.value = initiallyMuted ? 0 : 1;
    this.micSourceNode.connect(this.micGainNode);
    this.micGainNode.connect(this.destination);
  }
```

(`getSettings?.()?.channelCount` — the extra `?.` after the call, not just before it — defends against `getSettings()` itself returning `undefined`/`null` in some implementation, not just against `getSettings` not existing as a method at all.)

No other part of `audio-mixer.js` changes. Remote sources already connect directly to `this.destination` (no intermediate node), so forcing `this.destination`'s channel configuration in the constructor covers them too — they don't need their own `_forceStereoChannelConfig` call.

**Reading the evidence next time this reproduces:** in DevTools console, look for `[Asterion:audio-mixer] mic-track-settings` — if `channelCount` is `2` there, that rules out "the track is plainly mono" and makes Codex's alternative theory (already-stereo track with silence on channel 1) *plausible*, but it does **not by itself prove** channel 1 is silent — `getSettings()` only reports how many channels the track has, not what's actually in each one. Treat a `channelCount: 2` reading as a strong reason to do the raw-recording inspection in Task 2's manual verification (Step 3 there) before concluding anything, not as confirmation on its own. If `channelCount` is `1` (or `null`, meaning the browser didn't report it), the up-mix theory remains plausible and `mixer-channel-config-before` for `"destination"`/`"micGainNode"` tells us what their native defaults actually were.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/webrtc-bootstrap/audio-mixer.test.js`
Expected: PASS (24 tests — the 16 from the previous plan plus these 8 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/webrtc-bootstrap/audio-mixer.js src/webrtc-bootstrap/audio-mixer.test.js
git commit -m "debug: log mic/destination channel config and force explicit stereo as defensive hardening"
```

---

### Task 2: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Manual verification (report what could and couldn't be checked)**

This needs a real Google Meet recording, which can't be reproduced from this environment — report explicitly which of these were actually checked versus skipped:
1. Record a meeting, speak for a bit yourself, and confirm in the resulting mp3/mp4 whether your own voice is now audible on both the left and right channel (e.g. by checking with headphones, or a stereo VU meter in a media player/editor). **This is the actual test of whether the bug is fixed** — per Codex's review, there's a real chance it still isn't, since this task's fix is confirmed-cheap hardening, not a confirmed repair.
2. Open DevTools console during the recording and read the `[Asterion:audio-mixer]` log lines — specifically `mic-track-settings` (what `channelCount` did the mic track itself report?) and `mixer-channel-config-before` for `"destination"`/`"micGainNode"` (what were their native defaults before this task forced them to 2?). **Report these exact logged values.**
3. If the bug is **still present** after step 1, `getSettings().channelCount` alone can't tell us whether channel 1 actually carries silence — it only reports the channel count, not the content. Don't conclude anything from it alone; instead inspect the raw pre-conversion recording directly: open the meeting's saved folder (via the History page or `chrome://extensions` → this extension's storage), find the original `.webm` audio file (before mp3/mp4 conversion), and check its channel content in an editor that shows a per-channel waveform/level meter (e.g. Audacity, or any DAW — File → Open, look at the L/R tracks separately). That's the only way to directly confirm or rule out "channel 1 is silent at the source" versus a problem introduced later in `MediaRecorder`'s encoding or the ffmpeg conversion step.
4. Combine steps 2 and 3 to draw a conclusion:
   - `mic-track-settings`'s `channelCount` was `2`, **and** the raw `.webm` in step 3 shows channel 1 genuinely silent: this rules out the conversion step (mp3/mp4 encoding via ffmpeg) as the cause, since the asymmetry is already present in the file `MediaRecorder` itself produced — but it does **not** by itself distinguish "the mic track already came in that way" from "something in our Web Audio graph or `MediaRecorder`'s own encoding introduced it." Report both findings together rather than declaring a single confirmed root cause; the next investigation step would compare the same recording with `_forceStereoChannelConfig` temporarily removed (or with extra logging inside the graph itself) to isolate the Web Audio stage specifically, before committing to the fold-down/re-duplication approach described above.
   - `mic-track-settings`'s `channelCount` was `1` (or `null`) and the bug is now fixed: the up-mix theory was plausible, and forcing the gain node's channel config may have been the actual fix.
   - `mixer-channel-config-before` for `"destination"` already showed `channelCount: 2` natively (as Codex predicted it likely would, per spec defaults): that confirms the destination-side half of this task's fix was indeed a no-op. It does **not** by itself narrow the cause to the mic track/gain-node side specifically — `MediaRecorder`'s own encoding of the destination's stream, or the ffmpeg conversion, remain untested alternative stages until the raw-`.webm` inspection from step 3 (and, if needed, comparing with `_forceStereoChannelConfig` temporarily removed) rules them in or out.
   - The bug is fixed but `mic-track-settings` was already `2`: worth noting as a surprising result (would mean forcing the gain node's channel config somehow helped despite the track already being 2-channel) and reporting back rather than assuming it means the theory was wrong.
5. If the bug is still present after all of the above, do **not** attempt another blind fix — bring the exact logged values and the raw-`.webm` inspection result from steps 2-3 back for a fresh, evidence-grounded investigation instead.

- [ ] **Step 4: Commit** (only if step 3 uncovers something that needs a follow-up fix; otherwise this task produces no code changes to commit)
