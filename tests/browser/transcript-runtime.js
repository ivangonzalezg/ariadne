import { MeetCaptions } from "../../src/webrtc-bootstrap/meet-captions.js";
import { CaptionRouter } from "../../src/content/caption-router.js";
import { CaptionDelivery } from "../../src/content/caption-delivery.js";
import { SessionWriter } from "../../src/storage/session-writer.js";
import { enableCaptionsAndObserve } from "../../src/content/meet-caption-observer.js";
import { oldCaption, v2Caption, roster } from "../helpers/meet-protobuf.js";

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Browser condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const gzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

window.runTranscriptTest = async () => {
  // These fixtures test transport/storage in real Chrome; they do not assert Meet compatibility.
  const results = [], root = await navigator.storage.getDirectory();
  const writer = new SessionWriter({ sessionId: "browser-caption-test", meetingTitle: "Caption loopback" }); await writer.ready;
  let loseAck = true;
  const delivery = new CaptionDelivery({ sessionId: writer.sessionId, recover: async () => {}, send: async ({ event }) => {
    const ack = await writer.onCaptionEvent(event);
    if (loseAck) { loseAck = false; throw new Error("Simulated lost ACK"); }
    return ack;
  } });
  const router = new CaptionRouter({ sessionId: writer.sessionId, mode: "hybrid", emit: event => delivery.add(event) });
  const service = new MeetCaptions({ onCaption: event => router.receive(event), onStatus: status => router.setRtcStatus(status) });
  const local = new RTCPeerConnection(), remote = new RTCPeerConnection(), remoteChannels = new Map();
  local.onicecandidate = event => { if (event.candidate) remote.addIceCandidate(event.candidate).catch(() => {}); };
  remote.onicecandidate = event => { if (event.candidate) local.addIceCandidate(event.candidate).catch(() => {}); };
  remote.ondatachannel = ({ channel }) => remoteChannels.set(channel.label, channel);
  let stopDom;
  try {
    const collections = local.createDataChannel("collections");
    service.observe(collections, { pc: local, connectionId: 1 });
    await local.setLocalDescription(await local.createOffer()); await remote.setRemoteDescription(local.localDescription);
    await remote.setLocalDescription(await remote.createAnswer()); await local.setRemoteDescription(remote.localDescription);
    await wait(() => collections.readyState === "open"); service.start(writer.sessionId, "hybrid");
    await wait(() => remoteChannels.get("captions")?.readyState === "open");
    remoteChannels.get("collections").send(roster());
    remoteChannels.get("captions").send(await gzip(oldCaption(1, 1, "Primera frase")));
    await wait(() => service.utterances.size === 1);
    const v2 = local.createDataChannel("captions_v2"); service.observe(v2, { pc: local, connectionId: 1 });
    await wait(() => remoteChannels.get("captions_v2")?.readyState === "open");
    remoteChannels.get("captions_v2").send(await gzip(v2Caption(2, 1, "Segunda frase")));
    remoteChannels.get("captions").send(oldCaption(1, 2, "Primera frase completa"));
    await wait(() => service.utterances.size === 2 && [...service.utterances.values()][0].text === "Primera frase completa");
    await service.stop(); const errors = await delivery.flush(); assert(errors.length === 0, "Caption flush failed");
    const restored = await SessionWriter.restore(writer.folderName);
    await restored.finalize({ endedAt: Date.now(), expectedCaptionEvents: delivery.eventSeq });
    const output = JSON.parse(await (await (await restored.meetingHandle.getFileHandle("transcripcion.json")).getFile()).text());
    assert(output.length === 2 && output[0].text === "Primera frase completa" && output[1].text === "Segunda frase", "Caption loss or duplication");
    assert(output.every(segment => segment.speaker === "Ana"), "Roster attribution failed");
    assert(restored.transcriptStatus === "complete", "Unexpected incomplete transcript");
    results.push("Real WebRTC loopback: gzip, captions, captions_v2, revisions, roster", "Real OPFS: lost ACK retry, recovery, final export");

    document.body.innerHTML = '<button jsname="RrG0hf" aria-pressed="true" aria-controls="captions">CC</button><div role="region" id="captions"><div class="nMcdL bj4p3b"><span class="NWpY1d">Ana</span><span class="ygicle VbkSUe">Anterior</span></div></div>';
    const events = []; stopDom = enableCaptionsAndObserve(event => events.push(event));
    assert(events.length === 0, "DOM imported pre-recording text");
    const panel = document.getElementById("captions");
    panel.innerHTML = '<div class="nMcdL bj4p3b"><span class="NWpY1d">Ana</span><span class="ygicle VbkSUe">Nueva</span></div>'.repeat(2);
    await wait(() => events.length === 2);
    stopDom(); assert(new Set(events.map(e => e.utteranceId)).size === 2, "Distinct phrases collapsed");
    assert(getComputedStyle(panel).display !== "none", "Caption panel hidden");
    results.push("Real MutationObserver: baseline exclusion, multiple same-speaker blocks, visible panel");
    return { passed: true, checks: results, segments: output, durableEvents: restored.captions.events.size };
  } finally {
    stopDom?.(); await service.stop(); delivery.dispose(); local.close(); remote.close();
    await root.removeEntry(writer.folderName, { recursive: true });
  }
};

window.prepareTrustedCaptionToggle = () => {
  const button = document.querySelector('button[jsname="RrG0hf"]');
  button.setAttribute("aria-pressed", "true");
  button.addEventListener("click", () => button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true")));
  window.stopPauseObserver = enableCaptionsAndObserve(() => {}, { onStatus: status => { window.pauseStatus = status; } });
  const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
};
