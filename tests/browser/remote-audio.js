import { AudioOutputObserver } from "../../src/webrtc-bootstrap/audio-output-observer.js";
import { inspectRemoteReceivers } from "../../src/webrtc-bootstrap/rtc-patch.js";
import { MeetingAudioMixer } from "../../src/webrtc-bootstrap/audio-mixer.js";
import { installRtcPatch } from "../../src/webrtc-bootstrap/rtc-patch.js";
import { RemoteAudioMonitor } from "../../src/webrtc-bootstrap/remote-audio-monitor.js";
import { MainWorldSession } from "../../src/webrtc-bootstrap/session.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await wait(100);
  }
  throw new Error(`Timeout: ${label}`);
}

function amplitude(buffer, frequency) {
  const samples = buffer.getChannelData(0);
  const length = Math.min(buffer.sampleRate, samples.length);
  const offset = Math.floor((samples.length - length) / 2);
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < length; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / length);
    const phase = 2 * Math.PI * frequency * i / buffer.sampleRate;
    real += samples[offset + i] * window * Math.cos(phase);
    imaginary += samples[offset + i] * window * Math.sin(phase);
  }
  return 4 * Math.hypot(real, imaginary) / length;
}

export async function run() {
  const context = new AudioContext();
  await context.resume();
  const mixer = new MeetingAudioMixer({ audioContext: context, recordingType: "webrtc" });
  const playbackObserver = new AudioOutputObserver({ ignoredContext: context, mixer });
  playbackObserver.install();
  const monitor = new RemoteAudioMonitor({ mixer, playbackObserver });
  const connections = [];
  const oscillators = [];
  const audioElements = [];
  const results = [];
  let trackEvents = 0;
  let deliverTrackEvents = false;
  let disableOriginalReceiver = false;
  let disableBeforeTrackEvent = false;
  // Deliberately drop delivery to the mixer, while the patch retains metadata.
  installRtcPatch({ onRemoteAudioTrack: (payload) => { trackEvents++; if (disableBeforeTrackEvent) payload.track.enabled = false; if (deliverTrackEvents) monitor.addRemoteTrack(payload); }, onConnectionClosed: (id) => mixer.removeConnection(id) });

  function tone(frequency) {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    const gain = context.createGain();
    gain.gain.value = 0.1;
    const output = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(output);
    oscillator.start();
    oscillators.push(oscillator);
    return { gain, oscillator, stream: output.stream };
  }

  async function connect(stream, deferTrack = false) {
    const sender = new RTCPeerConnection({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    connections.push(sender, receiver);
    sender.onicecandidate = ({ candidate }) => { if (candidate) receiver.addIceCandidate(candidate).catch(() => {}); };
    receiver.onicecandidate = ({ candidate }) => { if (candidate) sender.addIceCandidate(candidate).catch(() => {}); };
    receiver.addEventListener("track", ({ streams, track }) => {
      const audio = document.createElement("audio");
      if (disableOriginalReceiver) {
        // Simulate a meeting playing a private copy and disabling the original.
        const playbackTrack = track.clone();
        playbackTrack.enabled = true;
        audio.srcObject = new MediaStream([playbackTrack]);
        track.enabled = false;
      } else audio.srcObject = streams[0] ?? new MediaStream([track]);
      audio.volume = 0;
      document.body.append(audio);
      audio.play().catch(() => {});
      audioElements.push(audio);
    });
    if (deferTrack) sender.addTransceiver("audio", { direction: "sendonly" });
    else sender.addTrack(stream.getAudioTracks()[0], stream);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    await until(() => receiver.connectionState === "connected", "WebRTC connected");
    return { sender, receiver };
  }

  async function record(label, expectRemote) {
    const chunks = [];
    const session = new MainWorldSession({ sessionId: label, mixer, initialMicMuted: false,
      postToIsolated: (message) => { if (message.type === "asterion:chunk") chunks.push(message.buffer); } });
    session.start();
    await wait(2200);
    const snapshot = monitor.getRemoteAudioSnapshot();
    await session.stop();
    assert(chunks.length >= 2, `${label}: recorder produced chunks`);
    const blob = new Blob(chunks, { type: "audio/webm" });
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const remoteAmplitude = amplitude(decoded, 440);
    const micAmplitude = amplitude(decoded, 880);
    assert(micAmplitude > 0.02, `${label}: local tone present (${micAmplitude})`);
    assert(expectRemote ? remoteAmplitude > 0.02 : remoteAmplitude < 0.002,
      `${label}: remote tone ${expectRemote ? "present" : "absent"} (${remoteAmplitude})`);
    assert(expectRemote ? snapshot.tracks[0]?.rms > 0.001 : snapshot.tracks[0]?.rms < 0.001,
      `${label}: remote diagnostic matches recorded signal ${JSON.stringify({ snapshot, remoteAmplitude, micAmplitude })}`);
    results.push({ label, remoteAmplitude, micAmplitude, duration: decoded.duration, chunkCount: chunks.length });
  }

  async function probePlaybackRoute(mic, remote) {
    mixer.recordingType = "hybrid"; mixer.remoteRoute = "hybrid";
    remote.oscillator.frequency.value = 550;
    mixer.setMicTrack(mic.stream.getAudioTracks()[0], { initiallyMuted: true });
    remote.gain.gain.value = 0;
    deliverTrackEvents = true;
    const chunks = [];
    const session = new MainWorldSession({ sessionId: "playback-route", mixer, initialMicMuted: true,
      postToIsolated: (message) => { if (message.type === "asterion:chunk") chunks.push(message.buffer); } });
    const checkpoints = [];
    const startedAt = performance.now();
    session.start(); monitor.start("playback-route");
    const pageContext = new AudioContext({ sinkId: { type: "none" } });
    await pageContext.resume();
    const moduleUrl = URL.createObjectURL(new Blob([`
      class DecodedTone extends AudioWorkletProcessor {
        constructor() { super(); this.phase = 0; this.level = 0.1;
          this.port.onmessage = ({data}) => { this.level = data; }; }
        process(inputs, outputs) {
          const channel = outputs[0][0];
          for (let i=0; i<channel.length; i++) { channel[i]=this.level*Math.sin(this.phase); this.phase+=2*Math.PI*440/sampleRate; }
          return true;
        }
      }
      registerProcessor('decoded-tone', DecodedTone);
    `], { type: "text/javascript" }));
    async function checkpoint(label, expectRemote, expectMic, expectReceiver = false) {
      await wait(1800);
      checkpoints.push({ label, centre: (performance.now() - startedAt) / 1000 - 0.8, expectRemote, expectMic, expectReceiver });
    }
    try {
      await pageContext.audioWorklet.addModule(moduleUrl);
      await connect(remote.stream);
      const playback = new AudioWorkletNode(pageContext, "decoded-tone");
      const output = pageContext.createGain();
      playback.connect(output); output.connect(pageContext.destination);
      output.connect(pageContext.destination); // Repeated native connects do not double the signal.
      await checkpoint("late playback while mic muted", true, false);
      const remoteOnly = monitor.getRemoteAudioSnapshot();
      assert(remoteOnly.tracks[0]?.enabled && !remoteOnly.tracks[0]?.muted, "live enabled RTC receiver");
      assert(remoteOnly.tracks[0]?.rms < 0.001 && remoteOnly.tracks[0]?.lastSignalAt === null, "RTC path delivers silence");
      assert(remoteOnly.recordingType === "hybrid", "recording selects page playback");
      assert(remoteOnly.playback.outputs.some((entry) => entry.nodeType === "GainNode" && entry.rms > 0.001 && entry.connectedToMixer), "page playback bridged with signal");
      session.onMicUnmuted(Date.now());
      await checkpoint("both voices", true, true);
      monitor._scan();
      assert(monitor.getRemoteAudioSnapshot().tracks.some((entry) => entry.connectedToMixer), "hybrid sweep reconnects a healthy receiver after event registration");
      remote.gain.gain.value = 0.1;
      await checkpoint("distinct routes remain simultaneous", true, true, true);
      output.disconnect(pageContext.destination);
      assert(mixer.playbackSources.size === 0, "disconnected playback removes its own bridge");
      await checkpoint("receiver fallback", false, true, true);
      const replacement = pageContext.createGain();
      playback.connect(replacement); replacement.connect(pageContext.destination);
      assert(mixer.playbackSources.size === 1, "reconnected playback captured immediately");
      await checkpoint("reconnected playback", true, true, true);
      await pageContext.suspend();
      await until(() => mixer.playbackSources.size === 0, "suspended playback bridge detached");
      await checkpoint("suspended playback uses receivers", false, true, true);
      await pageContext.resume();
      await until(() => mixer.playbackSources.size === 1, "resumed playback connected");
      remote.gain.gain.value = 0;
      playback.port.postMessage(0);
      await wait(61000);
      assert(mixer.playbackSources.size === 1, "61 seconds of silence preserves playback capture");
      playback.port.postMessage(0.1);
      await checkpoint("page voice returns after long silence", true, true);
      const flow = { remoteOnly, receivers: await inspectRemoteReceivers() };
      await session.stop(); monitor.stop();
      const decoded = await context.decodeAudioData(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
      for (const point of checkpoints) {
        const section = context.createBuffer(1, Math.floor(decoded.sampleRate * 0.6), decoded.sampleRate);
        const start = Math.floor((point.centre - 0.3) * decoded.sampleRate);
        section.copyToChannel(decoded.getChannelData(0).subarray(start, start + section.length), 0);
        point.remoteAmplitude = amplitude(section, 440);
        point.micAmplitude = amplitude(section, 880);
        point.receiverAmplitude = amplitude(section, 550);
        assert(point.expectReceiver ? point.receiverAmplitude > 0.07 && point.receiverAmplitude < 0.13 : point.receiverAmplitude < 0.002, `${point.label}: receiver voice (${point.receiverAmplitude})`);
        assert(point.expectRemote ? point.remoteAmplitude > 0.07 && point.remoteAmplitude < 0.13 : point.remoteAmplitude < 0.002,
          `${point.label}: remote routes match their identities (${point.remoteAmplitude})`);
        assert(point.expectMic ? point.micAmplitude > 0.07 && point.micAmplitude < 0.13 : point.micAmplitude < 0.002,
          `${point.label}: independent microphone (${point.micAmplitude})`);
      }
      assert(!playbackObserver.getSnapshot().active && mixer.playbackSources.size === 0, "session stop releases bridges");
      // Keep page nodes connected across sessions, as Meet does.
      mixer.setMicMuted(true);
      const secondChunks = [];
      const second = new MainWorldSession({ sessionId: "playback-second", mixer, initialMicMuted: true,
        postToIsolated: (message) => { if (message.type === "asterion:chunk") secondChunks.push(message.buffer); } });
      second.start(); monitor.start("playback-second");
      await wait(2200);
      await second.stop(); monitor.stop();
      const secondDecoded = await context.decodeAudioData(await new Blob(secondChunks, { type: "audio/webm" }).arrayBuffer());
      assert(amplitude(secondDecoded, 440) > 0.07 && amplitude(secondDecoded, 440) < 0.13 && amplitude(secondDecoded, 880) < 0.002,
        "second session reuses page outputs without duplicate bridges or microphone leakage");
      replacement.disconnect(); playback.disconnect();
      return { ok: true, scenario: "captured-WebAudio-playback", checkpoints, flow };
    } finally {
      monitor.stop(); URL.revokeObjectURL(moduleUrl); await pageContext.close();
    }
  }

  async function recordLateJoin(mic, remote, useTrackEvent, pendingReceiver = false) {
    deliverTrackEvents = useTrackEvent;
    const scenario = pendingReceiver ? "late-join-existing-muted-receiver" : useTrackEvent ? "late-join-track-event" : "late-join-receiver-sweep";
    const label = disableOriginalReceiver ? `${scenario}-original-disabled-${disableBeforeTrackEvent ? "before" : "after"}-capture` : scenario;
    mixer.setMicTrack(mic.stream.getAudioTracks()[0], { initiallyMuted: true });
    const chunks = [];
    const session = new MainWorldSession({ sessionId: label, mixer, initialMicMuted: true,
      postToIsolated: (message) => { if (message.type === "asterion:chunk") chunks.push(message.buffer); } });
    let pair = pendingReceiver ? await connect(remote.stream, true) : null;
    const startedAt = performance.now();
    session.start();
    monitor.start(label);
    assert(mixer.activeRemoteSourceCount === (pendingReceiver ? 1 : 0), `${label}: recording starts alone`);
    if (pendingReceiver) assert(pair.receiver.getReceivers()[0].track.muted, `${label}: receiver initially muted`);
    await wait(1200);
    if (pendingReceiver) await pair.sender.getSenders()[0].replaceTrack(remote.stream.getAudioTracks()[0]);
    else pair = await connect(remote.stream);
    await until(() => mixer.activeRemoteSourceCount === 1, `${label}: late remote source connected`);
    await wait(2200);
    const remoteOnlyAt = (performance.now() - startedAt) / 1000 - 1.1;
    const beforeUnmute = monitor.getRemoteAudioSnapshot();
    assert(beforeUnmute.tracks[0]?.rms > 0.001, `${label}: remote signal while own mic muted`);
    session.onMicUnmuted(Date.now());
    await wait(2200);
    const bothAt = (performance.now() - startedAt) / 1000 - 1.1;
    await session.stop();
    const decoded = await context.decodeAudioData(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
    const levelAt = (frequency, centre) => {
      const section = context.createBuffer(decoded.numberOfChannels, Math.floor(decoded.sampleRate * 0.6), decoded.sampleRate);
      const start = Math.floor((centre - 0.3) * decoded.sampleRate);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        section.copyToChannel(decoded.getChannelData(channel).subarray(start, start + section.length), channel);
      }
      return amplitude(section, frequency);
    };
    const remoteBeforeUnmute = levelAt(440, remoteOnlyAt);
    const micBeforeUnmute = levelAt(880, remoteOnlyAt);
    const remoteAfterUnmute = levelAt(440, bothAt);
    const micAfterUnmute = levelAt(880, bothAt);
    assert(remoteBeforeUnmute > 0.02 && micBeforeUnmute < 0.002,
      `${label}: remote retained while mic muted (${remoteBeforeUnmute}, ${micBeforeUnmute})`);
    assert(remoteAfterUnmute > 0.02 && micAfterUnmute > 0.02,
      `${label}: both voices after own unmute (${remoteAfterUnmute}, ${micAfterUnmute})`);
    results.push({ label, remoteBeforeUnmute, micBeforeUnmute, remoteAfterUnmute, micAfterUnmute, duration: decoded.duration });
    monitor.stop();
    pair.sender.close(); pair.receiver.close();
    await until(() => mixer.activeRemoteSourceCount === 0, `${label}: closed source removed`);
    deliverTrackEvents = false;
  }

  try {
    const mic = tone(880);
    const remote = tone(440);
    if (new URL(location.href).searchParams.has("hybrid")) return await (await import("./hybrid-audio.js")).runHybrid();
    if (new URL(location.href).searchParams.has("playback-route")) return await probePlaybackRoute(mic, remote);
    if (new URL(location.href).searchParams.has("disabled-receiver")) {
      disableOriginalReceiver = true;
      await recordLateJoin(mic, remote, true);
      disableBeforeTrackEvent = true;
      await recordLateJoin(mic, remote, true);
      return { ok: true, recordings: results };
    }
    await recordLateJoin(mic, remote, true);
    await recordLateJoin(mic, remote, false);
    await recordLateJoin(mic, remote, true, true);
    disableOriginalReceiver = true;
    await recordLateJoin(mic, remote, true);
    disableBeforeTrackEvent = true;
    await recordLateJoin(mic, remote, true);
    disableOriginalReceiver = false;
    disableBeforeTrackEvent = false;
    const eventsBeforeBaseline = trackEvents;
    remote.gain.gain.value = 0;
    mixer.setMicTrack(mic.stream.getAudioTracks()[0], { initiallyMuted: false });
    const first = await connect(remote.stream);
    assert(trackEvents > 0 && mixer.activeRemoteSourceCount === 0, "track event intentionally missed by mixer");
    monitor.start("browser-loopback");
    assert(mixer.activeRemoteSourceCount === 1, "receiver sweep recovered the source");
    await wait(750);
    assert(monitor.getRemoteAudioSnapshot().tracks[0].rms < 0.001, "own tone does not appear in remote diagnostics");
    await record("local-only", false);

    remote.gain.gain.value = 0.1;
    await record("both-tones", true);

    remote.gain.gain.value = 0;
    await wait(61000);
    assert(mixer.activeRemoteSourceCount === 1, "remote source retained after 61 seconds of acoustic mute");
    remote.gain.gain.value = 0.1;
    assert(trackEvents === eventsBeforeBaseline + 1, "unmute did not require another track event");
    await record("after-long-mute", true);

    first.sender.close();
    first.receiver.close();
    await connect(remote.stream);
    await until(() => mixer.activeRemoteSourceCount === 1, "periodic sweep recovers reconnection");
    await record("after-reconnect", true);
    const snapshot = monitor.getRemoteAudioSnapshot();
    monitor.stop(); connections.forEach((pc) => pc.close());
    await until(() => mixer.activeRemoteSourceCount === 0, "baseline sources closed before playback regression");
    const playbackCapture = await probePlaybackRoute(mic, remote);
    connections.forEach((pc) => pc.close());
    for (const audio of audioElements) {
      audio.srcObject?.getTracks().forEach((track) => track.stop());
      audio.srcObject = null; audio.remove();
    }
    const hybrid = await (await import("./hybrid-audio.js")).runHybrid();
    return { ok: true, trackEvents, snapshot, recordings: results, playbackCapture, hybrid };
  } finally {
    monitor.stop();
    connections.forEach((pc) => pc.close());
    oscillators.forEach((oscillator) => oscillator.stop());
    audioElements.forEach((audio) => { audio.srcObject?.getTracks().forEach((track) => track.stop()); audio.srcObject = null; audio.remove(); });
    await context.close();
  }
}
