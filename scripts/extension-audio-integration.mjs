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

export async function runExtensionIntegration({ root, debuggerUrl, origin, restartBrowser }) {
  const extension = await mkdtemp(join(tmpdir(), "ariadne-extension-test-"));
  const clients = []; let browser = await connect(debuggerUrl); clients.push(browser);
  let debuggingOrigin = new URL(debuggerUrl).origin.replace("ws:", "http:");
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
      document.documentElement.lang = 'en';
      const toggle = document.createElement('button'); toggle.setAttribute('jsname','RrG0hf');
      toggle.setAttribute('aria-pressed','true'); toggle.setAttribute('aria-controls','caption-test-panel');
      toggle.textContent = 'CC'; document.body.append(toggle);
      const panel = document.createElement('div'); panel.id = 'caption-test-panel'; panel.setAttribute('role','region'); document.body.append(panel);
    })()`);
    await wait(650);
    // get-status is a tab message; query the ISOLATED listener through tabs from the worker instead.
    const tabStatus = await worker.evaluate(`(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(tab=>tab.url===${JSON.stringify(`${origin}/tests/browser/extension-meeting.html`)});return chrome.tabs.sendMessage(tab.id,{type:'asterion:get-status'});})()`);
    assert(tabStatus.transcriptActive && !tabStatus.hasTranscript, 'Captions are ready during silence without claiming saved text');
    await page.evaluate(`document.getElementById('caption-test-panel').innerHTML='<div class="nMcdL bj4p3b"><span class="NWpY1d">Tú</span><span class="ygicle VbkSUe">Primera</span></div><div class="nMcdL bj4p3b"><span class="NWpY1d">Tú</span><span class="ygicle VbkSUe">Segunda</span></div>'`);
    await wait(4200);
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend','<div data-participant-id="self" data-tile-media-id="self"><button><i>frame_person</i></button><button><i>visual_effects</i></button><div jscontroller="sMwcOc"><div jsslot><span class="notranslate">Ana</span></div></div></div>')`);
    await wait(650);
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
    assert(transcript[0].speaker === 'Ana (you)' && transcript[1].speaker === 'Ana (you)' && transcript[2].speaker === 'Beto', 'Spanish self labels on an English document survive storage restart and mark only own captions');
    assert(manifestResult.localIdentity?.name === 'Ana', 'Manifest identifies the local extension user');
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
    await offscreen.evaluate(`chrome.runtime.sendMessage({type:"asterion:recover-storage"})`);
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
    assert(incompleteManifest.recordingStatus === "incomplete", "Partial capture remains incomplete after conversion");
    const prefix = await offscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(incomplete.folderName)});const bytes=new Uint8Array(await(await(await dir.getFileHandle('audio-reunion.webm')).getFile()).arrayBuffer());let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);})()`);
    const prefixDuration = await page.evaluate(`(async()=>{const ctx=new AudioContext();const bytes=Uint8Array.from(atob(${JSON.stringify(prefix)}),c=>c.charCodeAt(0));const decoded=await ctx.decodeAudioData(bytes.buffer);const duration=decoded.duration;await ctx.close();return duration;})()`);
    assert(prefixDuration>1.5, 'The continuous durable prefix remains decodable after definitive failure');
    console.log(JSON.stringify({storageFailure:{ok:true,recordingStatus:incomplete.recordingStatus,committedChunks:incompleteManifest.committedChunks,prefixDuration}},null,2));
    if (restartBrowser) {
      const videoCapture=await page.evaluate(`(async()=>{
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
        const paint=canvas.getContext('2d');let frame=0;const drawing=setInterval(()=>{paint.fillStyle=frame++%2?'green':'blue';paint.fillRect(0,0,64,64);},50);
        const ctx=new AudioContext();await ctx.resume();const tone=ctx.createOscillator();tone.frequency.value=440;
        const output=ctx.createMediaStreamDestination();tone.connect(output);tone.start();
        const stream=new MediaStream([...canvas.captureStream(10).getVideoTracks(),...output.stream.getAudioTracks()]);
        const recorder=new MediaRecorder(stream);const chunks=[];recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
        recorder.start(500);await new Promise(resolve=>setTimeout(resolve,1800));
        await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop();});
        clearInterval(drawing);tone.stop();stream.getTracks().forEach(track=>track.stop());await ctx.close();
        const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);
      })()`);
      const videoSessionId=`video-recovery-${Date.now()}`;
      const videoStarted=await offscreen.evaluate(`chrome.runtime.sendMessage({type:'asterion:session-starting',sessionId:${JSON.stringify(videoSessionId)},meetingTitle:'Interrupted video validation'})`);
      assert(videoStarted?.folderName, 'Video recovery fixture creates durable extension storage');
      for(const stream of ['meeting','video']) await offscreen.evaluate(`chrome.runtime.sendMessage({type:'asterion:chunk',sessionId:${JSON.stringify(videoSessionId)},stream:${JSON.stringify(stream)},seq:1,generation:0,captureTs:Date.now(),bufferBase64:${JSON.stringify(videoCapture)}})`);
      await worker.evaluate(`(async()=>{const {activeRecordingSessions}=await chrome.storage.local.get({activeRecordingSessions:{}});delete activeRecordingSessions[${JSON.stringify(videoSessionId)}];await chrome.storage.local.set({activeRecordingSessions});})()`);
      // Stage the exact v1 state that previously skipped conversion permanently.
      // Keep actual MediaRecorder bytes and remove only derived output/state.
      await worker.evaluate('chrome.offscreen.closeDocument()');
      const { targetId: storageTabId } = await browser.command("Target.createTarget", { url: `chrome-extension://${id}/src/offscreen/offscreen.html` });
      const storageTarget = await find(target => target.id === storageTabId);
      const storagePage = await connect(storageTarget.webSocketDebuggerUrl); clients.push(storagePage);
      await storagePage.evaluate(`(async()=>{
        const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(incomplete.folderName)});
        const read=async name=>JSON.parse(await(await(await dir.getFileHandle(name)).getFile()).text());
        const write=async(name,value)=>{const file=await dir.getFileHandle(name,{create:true});const writable=await file.createWritable();await writable.write(JSON.stringify(value));await writable.close();};
        const state=await read('capture-state.json'); state.conversions=[];delete state.recoveryTasks;delete state.recoveryVersion;delete state.recoveryRevision;delete state.publishedRevision;
        state.recordingStatus='incomplete';state.interruptionReason='capture-tab-disappeared';state.historyPublished=true;
        await write('capture-state.json',state);
        const video=await root.getDirectoryHandle(${JSON.stringify(videoStarted.folderName)});
        const videoState=JSON.parse(await(await(await video.getFileHandle('capture-state.json')).getFile()).text());
        videoState.recordingStatus='incomplete';videoState.interruptionReason='capture-tab-disappeared';videoState.endedAt=videoState.startedAt+1800;
        const videoWritable=await(await video.getFileHandle('capture-state.json')).createWritable();await videoWritable.write(JSON.stringify(videoState));await videoWritable.close();
        const manifest=await read('manifest.json');manifest.audioConversionStatus='failed';manifest.hasAudioMp3=false;await write('manifest.json',manifest);
        await dir.removeEntry('audio-reunion.mp3').catch(()=>{});
        // Also force a successful transcript task to discover its missing file.
        const complete=await root.getDirectoryHandle(${JSON.stringify(folderName)});
        await complete.removeEntry('transcripcion.json');
      })()`);
      const reopenedUrl = await restartBrowser();
      clients.forEach(client => client.socket.close());
      browser = await connect(reopenedUrl); clients.push(browser);
      debuggingOrigin = new URL(reopenedUrl).origin.replace("ws:", "http:");
      // Extensions.loadUnpacked is scoped to a debugging session. Reattach the
      // same path/ID to the same profile without uninstalling or clearing data.
      const reloaded = await browser.command("Extensions.loadUnpacked", { path: extension });
      assert(reloaded.id === id, 'Reopened Chrome uses the same extension storage identity');
      const { targetId: historyTabId } = await browser.command("Target.createTarget", { url: `chrome-extension://${id}/src/history/history.html` });
      const historyTarget = await find(target => target.id === historyTabId);
      const historyPage = await connect(historyTarget.webSocketDebuggerUrl); clients.push(historyPage);
      worker = await connect((await find(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${id}/`))).webSocketDebuggerUrl); clients.push(worker);
      let recovered;
      for (let attempt=0;attempt<150;attempt++) {
        const entries=await worker.evaluate('chrome.storage.local.get({meetingHistory:[]})');
        recovered=entries.meetingHistory.find(entry=>entry.sessionId===incomplete.sessionId);
        const filesRecovered=await historyPage.evaluate(`(async()=>{try{const root=await navigator.storage.getDirectory();const partial=await root.getDirectoryHandle(${JSON.stringify(incomplete.folderName)});const complete=await root.getDirectoryHandle(${JSON.stringify(folderName)});const audio=await(await partial.getFileHandle('audio-reunion.mp3')).getFile();const captions=JSON.parse(await(await(await complete.getFileHandle('transcripcion.json')).getFile()).text());const video=await root.getDirectoryHandle(${JSON.stringify(videoStarted.folderName)});const mp4=await(await video.getFileHandle('video-reunion.mp4')).getFile();return audio.size>0 && captions.length===3 && mp4.size>0;}catch{return false;}})()`);
        if(recovered?.hasAudioMp3 && filesRecovered && !recovered.processing?.pending) break;
        await wait(200);
      }
      assert(recovered?.hasAudioMp3 && recovered.recordingStatus==='incomplete','Same-profile browser restart recovers the old partial recording');
      const recoveryOffscreen=await connect((await find(target=>target.url.endsWith('src/offscreen/offscreen.html') && target.type!=='page')).webSocketDebuggerUrl);clients.push(recoveryOffscreen);
      const recoveredBytes=await recoveryOffscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(incomplete.folderName)});const bytes=new Uint8Array(await(await(await dir.getFileHandle('audio-reunion.mp3')).getFile()).arrayBuffer());let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);})()`);
      const recoveredDuration=await historyPage.evaluate(`(async()=>{const ctx=new AudioContext();const audio=await ctx.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(recoveredBytes)}),c=>c.charCodeAt(0)).buffer);await ctx.close();return audio.duration;})()`);
      assert(Math.abs(recoveredDuration-prefixDuration)<.3,'Recovered MP3 decodes and retains the saved prefix duration');
      const transcriptAfterRestart=await recoveryOffscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(folderName)});return JSON.parse(await(await(await dir.getFileHandle('transcripcion.json')).getFile()).text());})()`);
      assert(JSON.stringify(transcriptAfterRestart)===JSON.stringify(transcript),'Missing transcript is rebuilt after reopening with revisions and speakers intact');
      const recoveredVideoBytes=await recoveryOffscreen.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle(${JSON.stringify(videoStarted.folderName)});const bytes=new Uint8Array(await(await(await dir.getFileHandle('video-reunion.mp4')).getFile()).arrayBuffer());let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);})()`);
      const recoveredVideoDuration=await historyPage.evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(recoveredVideoBytes)}),c=>c.charCodeAt(0));const video=document.createElement('video');const url=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));video.src=url;await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Recovered MP4 does not decode'));});const result={duration:video.duration,width:video.videoWidth,height:video.videoHeight};URL.revokeObjectURL(url);return result;})()`);
      assert(recoveredVideoDuration.duration>1.5 && recoveredVideoDuration.width===64 && recoveredVideoDuration.height===64,'Recovered MP4 decodes with its saved duration and video frames');
      await historyPage.command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
      await historyPage.evaluate(`document.querySelector('.meeting-card')?.click()`);
      await wait(300);
      const recoveryUi=await historyPage.evaluate(`({message:document.querySelector('.recovery-message')?.textContent,status:document.querySelector('.recovery-status')?.textContent})`);
      assert(recoveryUi.message && recoveryUi.status,'History displays recovered processing state and the partial-recording notice');
      const screenshot=await historyPage.command('Page.captureScreenshot',{format:'png'});
      await writeFile(join(tmpdir(),'ariadne-recovery-history.png'),Buffer.from(screenshot.data,'base64'));
      console.log(JSON.stringify({browserRestartRecovery:{ok:true,recoveredDuration,recoveredVideoDuration,recordingStatus:recovered.recordingStatus,transcriptSegments:transcriptAfterRestart.length}},null,2));
    }
    await browser.command("Extensions.uninstall", { id });
  } finally {
    clients.forEach((client) => client.socket.close()); await rm(extension, { recursive: true, force: true });
  }
}
