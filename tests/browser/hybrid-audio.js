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
  const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
  const paint = canvas.getContext("2d"); let frame = 0;
  const drawing = setInterval(() => { paint.fillStyle = session.generation ? (frame++ % 2 ? "green" : "yellow") : (frame++ % 2 ? "red" : "blue"); paint.fillRect(0, 0, 32, 32); }, 50);
  const screen = canvas.captureStream(20);
  try {
    mixer.setMicMuted(true);
    assert(mixer.localSources.size === 0, "recording starts before an outgoing microphone is available");
    html.start(); playback.start(); session.start(); session.enableVideo(screen);
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
    await restarting; assert(screen.getVideoTracks()[0].readyState === "live", "pipeline restart preserves the screen track"); await wait(2500);
    points.push({ generation: 1, centre: 1.4, mic: true, html: true, webAudio: true });
    await session.stop(); html.stop(); playback.stop(); await converted;
    const manifest = JSON.parse(await (await writer.meetingHandle.getFileHandle("manifest.json")).getFile().then((file) => file.text()));
    assert(manifest.videoConversionStatus === "succeeded" && manifest.hasVideoMp4, "video conversion retains both recorder generations");
    assert(manifest.audioConversionStatus === "succeeded", `real OPFS WebM to MP3 conversion succeeds: ${JSON.stringify(manifest)}`);
    const decoder = new AudioContext();
    const mp3 = await (await writer.meetingHandle.getFileHandle("audio-reunion.mp3")).getFile();
    const decodedMp3 = await decoder.decodeAudioData(await mp3.arrayBuffer());
    const webm = await (await writer.meetingHandle.getFileHandle("audio-reunion.webm")).getFile();
    const decodedWebm = await decoder.decodeAudioData(await webm.arrayBuffer());
    const mp4 = await (await writer.meetingHandle.getFileHandle("video-reunion.mp4")).getFile();
    const decodedVideoAudio = await decoder.decodeAudioData(await mp4.arrayBuffer());
    assert(Math.abs(decodedVideoAudio.duration - decodedMp3.duration) < .5, `video audio retains both generations: videoAudio=${decodedVideoAudio.duration}, audio=${decodedMp3.duration}, segments=${JSON.stringify(manifest.captureSegments)}`);
    // The combined public files must retain the pre-restart and post-restart voices.
    for (const decoded of [decodedMp3, decodedWebm, decodedVideoAudio]) {
      const checks = [...points.filter((point) => point.generation === 0), { centre: decoded.duration - 1, mic: true, html: true, webAudio: true }];
      for (const { centre, mic, html: hasHtml, webAudio } of checks) {
        const measured = [440, 660, 880].map((frequency) => amplitude(decoded, frequency, centre));
        assert(hasHtml ? measured[0] > 0.06 && measured[0] < 0.14 : measured[0] < 0.002, `HTML voice matches state: ${measured}`);
        assert(webAudio ? measured[1] > 0.06 && measured[1] < 0.14 : measured[1] < 0.002, `Web Audio retained: ${measured}`);
        assert(mic ? measured[2] > 0.06 && measured[2] < 0.14 : measured[2] < 0.002, `local mute independent: ${measured}`);
      }
    }
    assert(decodedMp3.duration > 8 && Math.abs(decodedMp3.duration - decodedWebm.duration) < 0.3, "both generations survive conversion with consistent duration");
    const videoFile = await (await writer.meetingHandle.getFileHandle("video-reunion.mp4")).getFile();
    const video = document.createElement("video"), videoUrl = URL.createObjectURL(videoFile);
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("Video decode failed")); video.src = videoUrl; });
    const videoDuration = video.duration;
    assert(Math.abs(videoDuration - decodedMp3.duration) < .5, `video retains duration across generations: video=${videoDuration}, audio=${decodedMp3.duration}, segments=${JSON.stringify(manifest.captureSegments)}`);
    await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = () => reject(new Error("Video seek failed")); video.currentTime = videoDuration - .5; });
    const decodedFrame = document.createElement("canvas"); decodedFrame.width = 32; decodedFrame.height = 32;
    const pixels = decodedFrame.getContext("2d"); pixels.drawImage(video, 0, 0);
    assert(pixels.getImageData(16, 16, 1, 1).data[1] > 100, "post-restart video frames survive conversion");
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(videoUrl);
    await decoder.close();
    const sharedSignal = [];
    mixer.setMicMuted(true); rendered.node.disconnect(sourceContext.destination);
    remote.node.connect(sourceContext.destination);
    for (const route of ["html", "web-audio", "both"]) {
      if (route === "web-audio") html.stop(); else html.start();
      if (route === "html") playback.stop(); else playback.start();
      const blobs = [], recorder = new MediaRecorder(mixer.stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = ({ data }) => { if (data.size) blobs.push(data); }; recorder.start(2000);
      await wait(2100); await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
      const context = new AudioContext(), decoded = await context.decodeAudioData(await new Blob(blobs).arrayBuffer());
      const measured = amplitude(decoded, 440, 1);
      assert(decoded.duration > 1.8 && Number.isFinite(measured) && measured < .3, "shared-signal recording has valid duration and bounded amplitude");
      if (route !== "both") assert(measured > .06, `isolated ${route} retains the shared signal`);
      assert(mixer.htmlSources.size === (route === "web-audio" ? 0 : 1), "HTML identity does not produce extra sources");
      assert(mixer.playbackSources.size === (route === "html" ? 0 : 1), "Web Audio identity does not produce extra sources");
      sharedSignal.push({ route, amplitude: measured, duration: decoded.duration }); await context.close();
    }
    return { ok: true, sharedSignal, videoDuration, videoAudioDuration: decodedVideoAudio.duration, committedChunks: writer.committedChunks, mp3Duration: decodedMp3.duration, webmDuration: decodedWebm.duration, points };
  } finally {
    if (!session.stopping) await session.stop();
    clearInterval(drawing); screen.getTracks().forEach((track) => track.stop());
    html.stop(); playback.stop(); first.remove(); duplicate.remove();
    oscillators.forEach((oscillator) => oscillator.stop()); await mixer.close(); await sourceContext.close();
    const root = await navigator.storage.getDirectory(); await root.removeEntry(writer.meetingHandle.name, { recursive: true });
  }
}
