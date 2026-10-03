const context = new AudioContext(); await context.resume();
const sources = [];
function tone(frequency) {
  const oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
  oscillator.frequency.value = frequency; gain.gain.value = 0.1; oscillator.connect(gain); gain.connect(output); oscillator.start(); sources.push(oscillator);
  return { node: gain, stream: output.stream };
}
const htmlTone = tone(440), pageTone = tone(660), localTone = tone(880);
const audio = document.createElement("audio"); audio.srcObject = htmlTone.stream; document.body.append(audio);
const duplicate = document.createElement("audio"); duplicate.srcObject = htmlTone.stream; document.body.append(duplicate);
pageTone.node.connect(context.destination);
const pc = new RTCPeerConnection(); const sender = pc.addTrack(localTone.stream.getAudioTracks()[0]);
window.fixture = { context, audio, duplicate, pc, sender, htmlTone, pageTone, localTone };
if (new URLSearchParams(location.search).has("frame")) {
  document.querySelector("i").remove();
  const exclusive = tone(990); exclusive.node.connect(context.destination);
} else {
  const frame = document.createElement("iframe"); frame.src = "./extension-meeting.html?frame"; document.body.append(frame);
  window.fixture.frame = frame;
}
