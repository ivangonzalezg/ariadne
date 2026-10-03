// src/webrtc-bootstrap/bootstrap.js
import {
  installRtcPatch,
  installGetUserMediaPatch,
  installReplaceTrackPatch,
  getCurrentLocalAudioTrack,
  sweepLocalAudioTracks,
  inspectRemoteReceivers,
  diagnostics,
} from "./rtc-patch.js";
import { MeetingAudioMixer } from "./audio-mixer.js";
import { AudioOutputObserver } from "./audio-output-observer.js";
import { RemoteAudioMonitor } from "./remote-audio-monitor.js";
import { HtmlAudioObserver } from "./html-audio-observer.js";
import { RemoteMediaState } from "./remote-media-state.js";
import { CaptureHealth } from "./capture-health.js";
import { MainWorldSession } from "./session.js";
import { startSpeakerObserver } from "./speaker-observer.js";
import { debugEvent, debugLog, setDebugEnabled } from "../shared/debug-log.js";

if (!window.__ariadneCaptureInstalled) {
  window.__ariadneCaptureInstalled = true;
  const rtcPatchLog = (event, details) => debugEvent(`rtc-patch:${event}`, details);

  let mixer = new MeetingAudioMixer({
    log: (event, details) => debugEvent(`audio-mixer:${event}`, details),
  });
  mixer.resume().catch(() => {});
  const playbackObserver = new AudioOutputObserver({ ignoredContext: mixer.audioContext, mixer,
    log: (event, details) => debugEvent(`playback:${event}`, details) });
  playbackObserver.install();
  const remoteAudioMonitor = new RemoteAudioMonitor({ mixer, playbackObserver, log: rtcPatchLog });
  const htmlObserver = new HtmlAudioObserver({ mixer, log: rtcPatchLog });
  htmlObserver.install();
  const mediaState = new RemoteMediaState({ log: rtcPatchLog, onChange: () => health.schedule() });
  const health = new CaptureHealth({ getSession: () => session, getMixer: () => mixer,
    getRemoteMicState: (entry) => mediaState.get(entry.receiver),
    scan: () => {
      const locals = sweepLocalAudioTracks({ onSenderSweep: (id, senders) => mixer.reconcileLocalOwners(id, senders), onLocalAudioTrack: (track, owner) => mixer.setLocalSender(owner.sender, track, owner.connectionId), log: rtcPatchLog });
      for (const [id, entry] of mixer.localSources) if (!locals.has(id) && entry.track.readyState !== "live") mixer.removeLocalTrack(id);
      mixer.reconcile(); htmlObserver.scan(); remoteAudioMonitor._scan(); playbackObserver.sample();
      for (const entry of playbackObserver.outputs.values()) {
        const context = entry.node.deref()?.context;
        if (context?.state === "suspended") context.resume().catch((error) => rtcPatchLog("page-context-resume-error", { message: error.message }));
      }
    },
    restart: (reason) => {
      rtcPatchLog("capture-restart", { reason });
      return session?.restart(async () => {
        remoteAudioMonitor.stop(); htmlObserver.stop();
        await mixer.close();
        mixer = new MeetingAudioMixer({ log: rtcPatchLog });
        playbackObserver.mixer = mixer; playbackObserver.ignoredContext = mixer.audioContext;
        htmlObserver.mixer = mixer; remoteAudioMonitor.mixer = mixer;
        mixer.setMicMuted(currentlyMuted);
        await mixer.resume();
        if (session?.stopping) return mixer;
        htmlObserver.start();
        remoteAudioMonitor.start(session.sessionId, { managed: true, preserveSession: true });
        health.scan();
        return mixer;
      });
    }, log: rtcPatchLog });
  let lastStorageSnapshot = null;
  const storageQueries = new Map();
  let session = null;
  let starting = false;
  let startRequest = 0;
  let currentlyMuted = false;
  let stopSpeakerObserver = () => {};

  installRtcPatch({
    onRemoteAudioTrack: (payload) => { remoteAudioMonitor.addRemoteTrack(payload); health.schedule(); },
    onDataChannel: (channel) => mediaState.observe(channel),
    onLocalAudioTrack: (track, owner) => { mixer.setLocalSender(owner.sender, track, owner.connectionId); health.schedule(); },
    onConnectionClosed: (connectionId) => { mixer.removeConnection(connectionId); htmlObserver.scan(); },
    onConnectionStateChange: (state, id) => { mixer.connectionStates.set(id, state); health.schedule(); },
    log: rtcPatchLog,
  });

  installGetUserMediaPatch({
    onMicStream: (stream, audioTrack) => {
      rtcPatchLog("microphone-observed", { trackId: audioTrack.id });
    },
  });

  installReplaceTrackPatch({
    onAudioTrackReplaced: (newTrack, previousTrack, sender) => {
      mixer.setLocalSender(sender, newTrack);
      health.schedule();
    },
    log: rtcPatchLog,
  });

  function postToIsolated(message, transfer = []) {
    window.postMessage({ source: "asterion-main-world", ...message }, "*", transfer);
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || window !== window.top) return;
    const message = event.data;
    if (!message || message.source !== "asterion-isolated-world") return;

    debugLog("[Ariadne:debug] Message received from ISOLATED world", { type: message.type });

    if (message.type === "asterion:start-session") {
      if (session || starting) return;
      starting = true;
      const request = ++startRequest;
      try {
        setDebugEnabled(message.debugLogging);
        debugLog("[Ariadne:debug] asterion:start-session received; creating MainWorldSession and starting mixer", {
          sessionId: message.sessionId,
          mixer,
          session,
        });
        // Capture the sender used by the meeting; a missing sender can arrive later.
        const liveAudioTrack = getCurrentLocalAudioTrack({ log: rtcPatchLog });
        const trackToUse = liveAudioTrack;
        currentlyMuted = Boolean(message.initialMicMuted);
        rtcPatchLog("mic-track-resolved-for-session-start", {
          source: liveAudioTrack ? "sender-lookup" : "sender-pending",
          trackId: trackToUse?.id ?? null,
        });
        mixer.setMicMuted(currentlyMuted);

        sweepLocalAudioTracks({ onSenderSweep: (id, senders) => mixer.reconcileLocalOwners(id, senders), onLocalAudioTrack: (track, owner) => mixer.setLocalSender(owner.sender, track, owner.connectionId), log: rtcPatchLog });
        debugLog("[Ariadne] AudioContext state before resume():", mixer.audioContext.state);
        await mixer.resume();
        if (request !== startRequest) return;
        debugLog("[Ariadne] AudioContext state after resume():", mixer.audioContext.state);
        session = new MainWorldSession({
          sessionId: message.sessionId,
          mixer,
          postToIsolated,
          initialMicMuted: Boolean(message.initialMicMuted),
          onChunk: (size) => health.chunk(size),
          onRecorderError: () => health.recover("recorder-error"),
        });
        session.start();
        session.checkpoint();
        htmlObserver.start();
        remoteAudioMonitor.start(message.sessionId, { managed: true });
        health.start();
        postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });
        stopSpeakerObserver = startSpeakerObserver({
          onSpeakerLabel: (label) => postToIsolated({ type: "asterion:speaker-label", sessionId: message.sessionId, label }),
          log: rtcPatchLog,
        });
      } catch (error) {
        health.stop(); remoteAudioMonitor.stop(); htmlObserver.stop();
        session = null;
        rtcPatchLog("capture-start-error", { message: error.message });
        postToIsolated({ type: "asterion:start-failed", reason: error.message });
      } finally { if (request === startRequest) starting = false; }
    } else if (message.type === "asterion:chunk-committed") {
      if (session?.sessionId === message.sessionId) session.confirmChunk(message);
    } else if (message.type === "asterion:chunk-failed") {
      if (session?.sessionId === message.sessionId) rtcPatchLog("chunk-persistence-error", { generation: message.generation, seq: message.seq, message: message.message });
    } else if (message.type === "asterion:storage-progress") {
      storageQueries.get(message.requestId)?.(message);
      if (session?.sessionId === message.sessionId || !session) {
        lastStorageSnapshot = message;
        if (session) session.storage = message;
      }
    } else if (message.type === "asterion:mic-muted") {
      currentlyMuted = true;
      session?.onMicMuted(message.timestampMs);
    } else if (message.type === "asterion:mic-unmuted") {
      currentlyMuted = false;
      session?.onMicUnmuted(message.timestampMs);
    } else if (message.type === "asterion:stop-session") {
      startRequest++; starting = false;
      if (session) diagnostics.getAudioFlowSnapshot().catch((error) => rtcPatchLog("audio-flow-inspection-error", { message: error.message }));
      health.stop();
      await session?.stop({ interruptionReason: message.interruptionReason });
      session = null;
      remoteAudioMonitor.stop();
      htmlObserver.stop();
      stopSpeakerObserver();
      stopSpeakerObserver = () => {};
    }
  });

  document.addEventListener(
    "click",
    async (event) => {
      const target = event.composedPath().find((el) => el instanceof Element && el.matches("[data-asterion-enable-video]"));
      if (!target || !session) return;

      debugLog("[Ariadne] userActivation.isActive before getDisplayMedia:", navigator.userActivation?.isActive);

      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          preferCurrentTab: true,
        });
        session.enableVideo(displayStream);
        postToIsolated({ type: "asterion:video-enabled", sessionId: session.sessionId });
      } catch (error) {
        postToIsolated({
          type: "asterion:video-enable-failed",
          sessionId: session.sessionId,
          message: error.message,
        });
      }
    },
    true
  );

  diagnostics.getStorageSnapshot = async () => {
    const id = session?.sessionId ?? lastStorageSnapshot?.sessionId;
    if (!id) return null;
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { storageQueries.delete(requestId); resolve({ sessionId: id, available: false }); }, 5000);
      storageQueries.set(requestId, (snapshot) => { clearTimeout(timer); storageQueries.delete(requestId); resolve(snapshot); });
      postToIsolated({ type: "asterion:inspect-storage", sessionId: id, folderName: lastStorageSnapshot?.sessionId === id ? lastStorageSnapshot.folderName : undefined, requestId });
    });
  };
  diagnostics.getAudioFlowSnapshot = async () => {
    // Freeze levels before awaiting stats: stopping a session detaches analysers.
    const remoteAudio = remoteAudioMonitor.getRemoteAudioSnapshot();
    const mediaElements = [...document.querySelectorAll("audio, video")].map((element) => ({
      tag: element.tagName.toLowerCase(), paused: element.paused, muted: element.muted,
      volume: element.volume, readyState: element.readyState,
      streamId: element.srcObject?.id ?? null,
      tracks: (element.srcObject?.getAudioTracks?.() ?? []).map((track) => ({
        trackId: track.id, readyState: track.readyState, enabled: track.enabled, muted: track.muted,
      })),
    }));
    const snapshot = { storage: await diagnostics.getStorageSnapshot(), htmlAudio: htmlObserver.getSnapshot(), localAudio: mixer.getLocalSnapshot(), recordingType: mixer.recordingType, recorder: session ? { restarts: session.generation, generation: session.generation, state: session.meetingRecorder?.state, receivedChunks: session.receivedChunks, committedChunks: session.committedChunks } : null, timestampMs: Date.now(), remoteAudio, mediaElements, receivers: await inspectRemoteReceivers() };
    debugEvent("audio-flow-inspection", snapshot);
    return snapshot;
  };
  diagnostics.getRemoteAudioSnapshot = () => ({ ...remoteAudioMonitor.getRemoteAudioSnapshot(),
    htmlAudio: htmlObserver.getSnapshot(), localAudio: mixer.getLocalSnapshot(),
    recorder: session ? { generation: session.generation, state: session.meetingRecorder?.state, receivedChunks: session.receivedChunks, committedChunks: session.committedChunks } : null,
    storage: session ? session.storage ?? null : lastStorageSnapshot,
    recovery: health.getSnapshot(),
  });
  window.__asterionDiagnostics = diagnostics;

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") health.check(false); });

}
