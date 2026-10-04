import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function connect(url) {
  const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map(); const contexts = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.executionContextCreated") contexts.set(message.params.context.id, message.params.context);
    if (message.method === "Runtime.executionContextDestroyed") contexts.delete(message.params.executionContextId);
    const operation = pending.get(message.id); if (!operation) return;
    pending.delete(message.id); clearTimeout(operation.timer);
    if (message.error) operation.reject(new Error(JSON.stringify(message.error))); else operation.resolve(message.result);
  };
  const command = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
    const token = ++id; const timer = setTimeout(() => { pending.delete(token); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(token, { resolve, reject, timer }); socket.send(JSON.stringify({ id: token, method, params }));
  });
  return { socket, contexts, command, evaluate: async (expression, contextId, timeout) => {
    const value = await command("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, timeout);
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? JSON.stringify(value.exceptionDetails));
    return value.result.value;
  } };
}

export async function runExtensionIntegration({ root, debuggerUrl, origin }) {
  const extension = await mkdtemp(join(tmpdir(), "ariadne-extension-test-"));
  const clients = []; const browser = await connect(debuggerUrl); clients.push(browser);
  const debuggingOrigin = new URL(debuggerUrl).origin.replace("ws:", "http:");
  const list = async () => (await fetch(`${debuggingOrigin}/json/list`)).json();
  const find = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const target = (await list()).find(predicate); if (target) return target;
      await wait(100);
    }
    throw new Error(`Extension target unavailable: ${JSON.stringify((await list()).map(({id,type,url})=>({id,type,url})))}`);
  };
  try {
    for (const name of ["src", "dist", "icons", "_locales"]) await cp(join(root, name), join(extension, name), { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    for (const script of manifest.content_scripts) script.matches.push(`${origin}/*`);
    manifest.host_permissions.push(`${origin}/*`);
    for (const resources of manifest.web_accessible_resources) resources.matches.push(`${origin}/*`);
    await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
    const { id } = await browser.command("Extensions.loadUnpacked", { path: extension });
    const workerTarget = await find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`));
    let worker = await connect(workerTarget.webSocketDebuggerUrl); clients.push(worker);
    for (let attempt=0; attempt<100; attempt++) {
      if (await worker.evaluate('typeof chrome !== "undefined" && !!chrome.storage?.local')) break;
      await wait(50);
    }
    await worker.evaluate('chrome.storage.local.set({autoStart:true, debugLogging:false}); globalThis.__testWorkerToken="original"');
    const { targetId } = await browser.command("Target.createTarget", { url: `${origin}/tests/browser/extension-meeting.html` });
    const target = await find((target) => target.id === targetId);
    const page = await connect(target.webSocketDebuggerUrl); clients.push(page); await page.command("Runtime.enable");
    let snapshot;
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await page.evaluate('window.__asterionDiagnostics?.getRemoteAudioSnapshot()');
      if (snapshot?.recorder?.state === "recording" && snapshot.htmlAudio.streams.length === 1) break;
      await wait(100);
    }
    assert(snapshot?.recorder?.state === "recording", "Manifest MAIN and ISOLATED start the real recorder");
    assert(snapshot.htmlAudio.streams[0].references === 2, "Real HTML owners share one effective source");
    const sessionId = snapshot.sessionId;
    await page.evaluate(await readFile(join(root, "dist/webrtc-bootstrap.bundle.js"), "utf8"));
    const afterReinjection = await page.evaluate('window.__asterionDiagnostics.getRemoteAudioSnapshot()');
    assert(afterReinjection.sessionId === sessionId && afterReinjection.recorder.generation === 0 && afterReinjection.htmlAudio.streams.length === 1,
      "Repeated MAIN instrumentation preserves a single recorder and effective HTML source");
    const isolated = [...page.contexts.values()].find((context) => context.origin === `chrome-extension://${id}` || context.name === id);
    assert(isolated, `ISOLATED context present: ${JSON.stringify([...page.contexts.values()])}`);
    await page.evaluate(`(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime); window.__deliveryOriginal = original; let lost = false; let captionLost = false; let recovered = false;
      chrome.runtime.sendMessage = async function(message, ...args) {
        if (message.type === "asterion:chunk" && message.seq === 2 && !recovered) return { error: "Injected transport gap", retryable: true };
        const result = await original(message, ...args);
        if (message.type === "asterion:recover-storage") recovered = true;
        if (message.type === 'asterion:caption-event' && !captionLost) { captionLost = true; throw new Error('Injected caption ACK loss'); }
        if (message.type === 'asterion:chunk' && !lost) { lost = true; throw new Error('Injected lost ACK'); }
        return result;
      };
    })()`, isolated.id);
    await page.evaluate(`(() => {
      const toggle = document.createElement('button'); toggle.setAttribute('jsname','RrG0hf');
      toggle.setAttribute('aria-pressed','true'); toggle.setAttribute('aria-controls','caption-test-panel');
      toggle.textContent = 'CC'; document.body.append(toggle);
      const panel = document.createElement('div'); panel.id = 'caption-test-panel'; panel.setAttribute('role','region'); document.body.append(panel);
    })()`);
    await wait(650);
    // get-status is a tab message; query the ISOLATED listener through tabs from the worker instead.
    const tabStatus = await worker.evaluate(`(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(tab=>tab.url===${JSON.stringify(`${origin}/tests/browser/extension-meeting.html`)});return chrome.tabs.sendMessage(tab.id,{type:'asterion:get-status'});})()`);
    assert(tabStatus.transcriptActive && !tabStatus.hasTranscript, 'Captions are ready during silence without claiming saved text');
    await page.evaluate(`document.getElementById('caption-test-panel').innerHTML='<div class="nMcdL bj4p3b"><span class="NWpY1d">Ana</span><span class="ygicle VbkSUe">Primera</span></div><div class="nMcdL bj4p3b"><span class="NWpY1d">Ana</span><span class="ygicle VbkSUe">Segunda</span></div>'`);
    await wait(4200);
    await worker.evaluate('chrome.offscreen.closeDocument()');
    await wait(2200);
    await browser.command("Target.closeTarget", { targetId: workerTarget.id });
    await wait(2200);
    const restoredWorkerTarget = await find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`));
    worker = await connect(restoredWorkerTarget.webSocketDebuggerUrl); clients.push(worker);
    assert(await worker.evaluate('globalThis.__testWorkerToken') !== "original", "Service worker memory was recreated");
    await page.evaluate('document.querySelector("[data-is-muted]").setAttribute("data-is-muted","false")');
    await wait(7500);
    snapshot = await page.evaluate('window.__asterionDiagnostics.getRemoteAudioSnapshot()');
    assert(snapshot.recorder.generation === 0, "Storage restore preserves the active recorder generation");
    assert(snapshot.storage?.storageRecoveries >= 1, "An aged gap recovers even while later chunks keep committing");
    assert(snapshot.recorder.committedChunks >= 6, "Durable commits continue after offscreen loss");
    const frames = await page.evaluate('({ installed:fixture.frame.contentWindow.__ariadneCaptureInstalled, recorder:fixture.frame.contentWindow.__asterionDiagnostics.getRemoteAudioSnapshot().recorder })');
    assert(frames.installed && frames.recorder === null, "Subframes are instrumented with no independent recorder");
    await page.evaluate(`(() => {
      const panel = document.getElementById('caption-test-panel');
      panel.querySelector('.ygicle').textContent = 'Primera completa';
      panel.insertAdjacentHTML('beforeend','<div class="nMcdL bj4p3b"><span class="NWpY1d">Beto</span><span class="ygicle VbkSUe">Última</span></div>');
      window.postMessage({source:'asterion-isolated-world',type:'asterion:stop-session'},'*');
    })()`);
    let history;
    for (let attempt = 0; attempt < 100; attempt++) {
      history = await worker.evaluate('chrome.storage.local.get({meetingHistory:[]})');
      if (history.meetingHistory.some((entry) => entry.sessionId === sessionId)) break;
      await wait(100);
    }
    assert(history.meetingHistory.filter((entry) => entry.sessionId === sessionId).length === 1, "History finalizes once after restoration");
    const folderName = history.meetingHistory.find((entry) => entry.sessionId === sessionId).folderName;
    const offscreenTarget = await find((target) => target.url.endsWith("src/offscreen/offscreen.html"));
    const offscreen = await connect(offscreenTarget.webSocketDebuggerUrl); clients.push(offscreen);
    let manifestResult;
    for (let attempt = 0; attempt < 150; attempt++) {
      manifestResult = await offscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const directory=await root.getDirectoryHandle(${JSON.stringify(folderName)});return JSON.parse(await (await (await directory.getFileHandle('manifest.json')).getFile()).text());})()`);
      if (manifestResult.audioConversionStatus === "succeeded") break;
      if (manifestResult.audioConversionStatus === "failed") throw new Error(`Conversion failed: ${JSON.stringify(manifestResult)}`);
      await wait(200);
    }
    const durableSnapshot = await page.evaluate('window.__asterionDiagnostics.getStorageSnapshot()');
    assert(durableSnapshot.available && durableSnapshot.conversions.some(job=>job.state==='succeeded'), 'Console diagnostics query current durable conversion state');
    assert(manifestResult.recordingStatus === "complete" && manifestResult.hasAudioMp3, "Real OPFS and packaged FFmpeg produce a complete MP3");
    const transcript = await offscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(folderName)});return JSON.parse(await(await(await dir.getFileHandle('transcripcion.json')).getFile()).text());})()`);
    assert(transcript.length === 3 && transcript.map(segment=>segment.text).join('|') === 'Primera completa|Segunda|Última', 'Packaged extension drains the final caption and restores earlier captions without duplicates');
    assert(manifestResult.transcriptStatus === 'complete', 'Caption persistence stays complete across ACK loss and offscreen/worker restarts');
    console.log(JSON.stringify({transcriptIntegration:{ok:true,segments:transcript}},null,2));
    const results = [];
    for (const name of ["audio-reunion.webm", "audio-reunion.mp3"]) {
      const base64 = await offscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(folderName)});const bytes=new Uint8Array(await(await(await dir.getFileHandle(${JSON.stringify(name)})).getFile()).arrayBuffer());let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);})()`);
      const decoded = await page.evaluate(`(async()=>{
        const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));const ctx=new AudioContext();const audio=await ctx.decodeAudioData(bytes.buffer);
        const amplitude=(frequency,centre)=>{const samples=audio.getChannelData(0),n=Math.floor(audio.sampleRate*.6),offset=Math.floor(centre*audio.sampleRate)-Math.floor(n/2);let re=0,im=0;for(let i=0;i<n;i++){const sample=samples[offset+i]*(.5-.5*Math.cos(2*Math.PI*i/n));const phase=2*Math.PI*frequency*i/audio.sampleRate;re+=sample*Math.cos(phase);im+=sample*Math.sin(phase);}return 4*Math.hypot(re,im)/n;};
        const result={duration:audio.duration, early:[440,660,880,990].map(f=>amplitude(f,2)),late:[440,660,880,990].map(f=>amplitude(f,audio.duration-1))};await ctx.close();return result;
      })()`);
      assert(decoded.duration > 8, `${name} retains duration through storage restoration`);
      for (const values of [decoded.early, decoded.late]) {
        assert(values[0] > .06 && values[0] < .14 && values[1] > .06 && values[1] < .14, `${name} retains distinct remote sources once: ${values}`);
        assert(values[3] < .002, `${name} does not claim capture of subframe-only audio`);
      }
      assert(decoded.early[2] < .002 && decoded.late[2] > .06, `${name} preserves local mute without leakage`);
      results.push({ file: name, ...decoded });
    }
    assert(Math.abs(results[0].duration - results[1].duration) < .3, "WebM and MP3 duration agree");
    await worker.evaluate(`chrome.runtime.sendMessage({type:"asterion:recover-storage"})`);
    const restoredHistory = await worker.evaluate('chrome.storage.local.get({meetingHistory:[]})');
    assert(restoredHistory.meetingHistory.filter(entry=>entry.sessionId===sessionId).length===1, "Recovery does not duplicate history");
    const alarm = await worker.evaluate('chrome.alarms.get("asterion-storage-recovery")');
    assert(!alarm, "Recovery alarm removed when recording and conversions finish");
    console.log(JSON.stringify({ extensionIntegration: { ok: true, sessionId, committedChunks: manifestResult.committedChunks, frames, files: results } }, null, 2));
    await page.evaluate(`(() => {
      const original=window.__deliveryOriginal;
      chrome.runtime.sendMessage=async function(message,...args){
        if(message.type==='asterion:chunk' && message.seq>=2) return {error:'Injected quota exhaustion',retryable:false,code:'QuotaExceededError'};
        return original(message,...args);
      };
    })()`, isolated.id);
    const tabId = await worker.evaluate(`(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(tab=>tab.url?.startsWith(${JSON.stringify(origin + "/tests/browser/extension-meeting.html")})).id;})()`);
    await worker.evaluate(`chrome.tabs.sendMessage(${tabId},{type:'asterion:popup-start'})`);
    await wait(6500);
    const incompleteHistory = await worker.evaluate('chrome.storage.local.get({meetingHistory:[]})');
    const incomplete = incompleteHistory.meetingHistory.find(entry=>entry.sessionId!==sessionId);
    assert(incomplete?.recordingStatus==='incomplete', 'Definitive storage failure stops and marks the recording incomplete');
    const incompleteManifest = await offscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(incomplete.folderName)});return JSON.parse(await(await(await dir.getFileHandle('manifest.json')).getFile()).text());})()`);
    assert(!incompleteManifest.hasAudioMp3 && incompleteManifest.audioConversionStatus==='failed', 'Partial audio is not marked as a complete MP3');
    const prefix = await offscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(incomplete.folderName)});const bytes=new Uint8Array(await(await(await dir.getFileHandle('audio-reunion.webm')).getFile()).arrayBuffer());let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);})()`);
    const prefixDuration = await page.evaluate(`(async()=>{const ctx=new AudioContext();const bytes=Uint8Array.from(atob(${JSON.stringify(prefix)}),c=>c.charCodeAt(0));const decoded=await ctx.decodeAudioData(bytes.buffer);const duration=decoded.duration;await ctx.close();return duration;})()`);
    assert(prefixDuration>1.5, 'The continuous durable prefix remains decodable after definitive failure');
    console.log(JSON.stringify({storageFailure:{ok:true,recordingStatus:incomplete.recordingStatus,committedChunks:incompleteManifest.committedChunks,prefixDuration}},null,2));
    await browser.command("Extensions.uninstall", { id });
  } finally {
    clients.forEach((client) => client.socket.close()); await rm(extension, { recursive: true, force: true });
  }
}
