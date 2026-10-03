import { MeetingAudioMixer } from "../../src/webrtc-bootstrap/audio-mixer.js";
import { HtmlAudioObserver } from "../../src/webrtc-bootstrap/html-audio-observer.js";
import { AudioOutputObserver } from "../../src/webrtc-bootstrap/audio-output-observer.js";
import { MainWorldSession } from "../../src/webrtc-bootstrap/session.js";
import { SessionWriter } from "./conversion.bundle.js";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
function amplitude(buffer, frequency, centre) {
  const samples = buffer.getChannelData(0), count = Math.floor(buffer.sampleRate * 0.6);
  const offset = Math.max(0, Math.floor(centre * buffer.sampleRate) - count / 2);
  let re = 0, im = 0;
  for (let index = 0; index < count; index++) {
    const phase = 2 * Math.PI * frequency * index / buffer.sampleRate;
    const sample = samples[offset + index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / count));
    re += sample * Math.cos(phase); im += sample * Math.sin(phase);
  }
  return 4 * Math.hypot(re, im) / count;
}
export async function runHybrid() {
  globalThis.chrome = { runtime: { getURL: (path) => new URL(`/${path}`, location.origin).href,
    sendMessage: async () => ({ videoPreset: "medium" }) } };
  const sourceContext = new AudioContext({ sinkId: { type: "none" } });
  await sourceContext.resume();
  const oscillators = [];
  function tone(frequency) {
    const oscillator = sourceContext.createOscillator(), gain = sourceContext.createGain();
    oscillator.frequency.value = frequency; gain.gain.value = 0.1; oscillator.connect(gain); oscillator.start(); oscillators.push(oscillator);
    const destination = sourceContext.createMediaStreamDestination(); gain.connect(destination);
    return { node: gain, stream: destination.stream };
  }
  let mixer = new MeetingAudioMixer(); await mixer.resume();
  const playback = new AudioOutputObserver({ mixer, ignoredContext: mixer.audioContext }); playback.install();
  const html = new HtmlAudioObserver({ mixer }); html.install();
  const writer = new SessionWriter({ sessionId: "hybrid-native", tabId: 0, meetingTitle: "Audio validation" });
  await writer.ready;
  let finish; const converted = new Promise((resolve) => { finish = resolve; }); writer.onConversionsFinished = finish;
  const session = new MainWorldSession({ sessionId: writer.sessionId, mixer, initialMicMuted: true,
    postToIsolated: async (message) => {
      if (message.type === "asterion:chunk") return writer.writeChunk(message.stream, message.buffer, message);
      if (message.type === "asterion:session-ended") return writer.finalize(message);
    } });
  const local = tone(880), remote = tone(440), rendered = tone(660);
  const first = document.createElement("audio"), duplicate = document.createElement("audio");
  first.srcObject = remote.stream; duplicate.srcObject = remote.stream;
  document.body.append(first, duplicate);
  const points = [];
  try {
    mixer.setMicMuted(true);
    assert(mixer.localSources.size === 0, "recording starts before an outgoing microphone is available");
    html.start(); playback.start(); session.start();
    assert(mixer.htmlSources.size === 1, "two HTML owners share one source");
    await wait(1800); points.push({ generation: 0, centre: 0.9, mic: false, html: true, webAudio: false });
    rendered.node.connect(sourceContext.destination);
    await wait(2200); points.push({ generation: 0, centre: 3.0, mic: false, html: true, webAudio: true });
    mixer.addLocalTrack(local.stream.getAudioTracks()[0]);
    session.onMicUnmuted(Date.now()); await wait(2200);
    points.push({ generation: 0, centre: 5.1, mic: true, html: true, webAudio: true });
    first.remove(); await wait(20); assert(mixer.htmlSources.size === 1, "first HTML owner removed without dropping the second");
    duplicate.srcObject = null; assert(mixer.htmlSources.size === 0, "null assignment detaches final HTML owner immediately");
    await wait(1700); points.push({ generation: 0, centre: 7.2, mic: true, html: false, webAudio: true });
    duplicate.srcObject = remote.stream;
    const restarting = session.restart(async () => {
      html.stop(); playback.stop(); await mixer.close();
      mixer = new MeetingAudioMixer(); await mixer.resume();
      html.mixer = mixer; playback.mixer = mixer; playback.ignoredContext = mixer.audioContext;
      mixer.setMicMuted(false); mixer.addLocalTrack(local.stream.getAudioTracks()[0]); html.start(); playback.start();
      return mixer;
    });
    assert(session.restart(async () => { throw new Error("duplicate restart"); }) === restarting, "concurrent restarts coalesced");
    await restarting; await wait(2500);
    points.push({ generation: 1, centre: 1.4, mic: true, html: true, webAudio: true });
    await session.stop(); html.stop(); playback.stop(); await converted;
    const manifest = JSON.parse(await (await writer.meetingHandle.getFileHandle("manifest.json")).getFile().then((file) => file.text()));
    assert(manifest.audioConversionStatus === "succeeded", `real OPFS WebM to MP3 conversion succeeds: ${JSON.stringify(manifest)}`);
    const decoder = new AudioContext();
    const mp3 = await (await writer.meetingHandle.getFileHandle("audio-reunion.mp3")).getFile();
    const decodedMp3 = await decoder.decodeAudioData(await mp3.arrayBuffer());
    const webm = await (await writer.meetingHandle.getFileHandle("audio-reunion.webm")).getFile();
    const decodedWebm = await decoder.decodeAudioData(await webm.arrayBuffer());
    // The combined public files must retain the pre-restart and post-restart voices.
    for (const decoded of [decodedMp3, decodedWebm]) {
      const checks = [...points.filter((point) => point.generation === 0), { centre: decoded.duration - 1, mic: true, html: true, webAudio: true }];
      for (const { centre, mic, html: hasHtml, webAudio } of checks) {
        const measured = [440, 660, 880].map((frequency) => amplitude(decoded, frequency, centre));
        assert(hasHtml ? measured[0] > 0.06 && measured[0] < 0.14 : measured[0] < 0.002, `HTML voice matches state: ${measured}`);
        assert(webAudio ? measured[1] > 0.06 && measured[1] < 0.14 : measured[1] < 0.002, `Web Audio retained: ${measured}`);
        assert(mic ? measured[2] > 0.06 && measured[2] < 0.14 : measured[2] < 0.002, `local mute independent: ${measured}`);
      }
    }
    assert(decodedMp3.duration > 8 && Math.abs(decodedMp3.duration - decodedWebm.duration) < 0.3, "both generations survive conversion with consistent duration");
    await decoder.close();
    return { ok: true, committedChunks: writer.committedChunks, mp3Duration: decodedMp3.duration, webmDuration: decodedWebm.duration, points };
  } finally {
    if (!session.stopping) await session.stop();
    html.stop(); playback.stop(); first.remove(); duplicate.remove();
    oscillators.forEach((oscillator) => oscillator.stop()); await mixer.close(); await sourceContext.close();
    const root = await navigator.storage.getDirectory(); await root.removeEntry(writer.meetingHandle.name, { recursive: true });
  }
}
