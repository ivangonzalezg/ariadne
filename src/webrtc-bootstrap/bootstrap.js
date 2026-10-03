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
      const locals = sweepLocalAudioTracks({ onLocalAudioTrack: (track) => mixer.addLocalTrack(track), log: rtcPatchLog });
      for (const [id, entry] of mixer.localSources) if (!locals.has(id) && entry.track.readyState !== "live") mixer.removeLocalTrack(id);
      htmlObserver.scan(); mixer.reconcile(); remoteAudioMonitor._scan(); playbackObserver.sample();
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
        await mixer.resume(); htmlObserver.start();
        remoteAudioMonitor.start(session.sessionId, { managed: true, preserveSession: true });
        health.scan();
        return mixer;
      });
    }, log: rtcPatchLog });
  let session = null;
  let starting = false;
  let startRequest = 0;
  let currentlyMuted = false;
  let stopSpeakerObserver = () => {};

  installRtcPatch({
    onRemoteAudioTrack: (payload) => { remoteAudioMonitor.addRemoteTrack(payload); health.schedule(); },
    onDataChannel: (channel) => mediaState.observe(channel),
    onLocalAudioTrack: (track) => { mixer.addLocalTrack(track); health.schedule(); },
    onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
    onConnectionStateChange: () => health.schedule(),
    log: rtcPatchLog,
  });

  installGetUserMediaPatch({
    onMicStream: (stream, audioTrack) => {
      rtcPatchLog("microphone-observed", { trackId: audioTrack.id });
    },
  });

  installReplaceTrackPatch({
    onAudioTrackReplaced: (newTrack) => {
      if (!newTrack) {
        // replaceTrack(null) es un uso legítimo de la API (Meet deja de enviar
        // audio saliente por esa conexión) - no significa que el micrófono real
        // dejó de andar, así que seguimos usando el último track bueno que
        // tenemos en vez de cortar la grabación. Se deja logueado explícitamente
        // para poder ver si esto pasa en la práctica.
        rtcPatchLog("mic-track-replaced-with-null", {});
        return;
      }
      mixer.addLocalTrack(newTrack);
      health.schedule();
    },
    log: rtcPatchLog,
  });

  const pendingCommits = new Map();
  function postToIsolated(message, transfer = []) {
    if (message.type !== "asterion:chunk") {
      window.postMessage({ source: "asterion-main-world", ...message }, "*", transfer);
      return;
    }
    return new Promise((resolve) => {
      const key = `${message.sessionId}:${message.stream}:${message.generation}:${message.seq}`;
      const timer = setTimeout(() => {
        pendingCommits.delete(key);
        rtcPatchLog("chunk-confirmation-timeout", { generation: message.generation, seq: message.seq });
        resolve({ committed: false });
      }, 10000);
      pendingCommits.set(key, (result) => { clearTimeout(timer); pendingCommits.delete(key); resolve(result); });
      window.postMessage({ source: "asterion-main-world", ...message }, "*", transfer);
    });
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || window !== window.top) return;
    const message = event.data;
    if (!message || message.source !== "asterion-isolated-world") return;

    debugLog("[Ariadne:debug] mensaje recibido desde ISOLATED world", { type: message.type });

    if (message.type === "asterion:start-session") {
      if (session || starting) return;
      starting = true;
      const request = ++startRequest;
      try {
        setDebugEnabled(message.debugLogging);
        debugLog("[Ariadne:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {
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
        if (trackToUse) mixer.addLocalTrack(trackToUse);
        sweepLocalAudioTracks({ onLocalAudioTrack: (track) => mixer.addLocalTrack(track), log: rtcPatchLog });
        debugLog("[Ariadne] AudioContext state antes de resume():", mixer.audioContext.state);
        await mixer.resume();
        if (request !== startRequest) return;
        debugLog("[Ariadne] AudioContext state después de resume():", mixer.audioContext.state);
        session = new MainWorldSession({
          sessionId: message.sessionId,
          mixer,
          postToIsolated,
          initialMicMuted: Boolean(message.initialMicMuted),
          onChunk: (size) => health.chunk(size),
          onRecorderError: () => health.recover("recorder-error"),
        });
        session.start();
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
      pendingCommits.get(`${message.sessionId}:${message.stream}:${message.generation}:${message.seq}`)?.({ committed: true });
      if (session?.sessionId === message.sessionId) session.confirmChunk(message);
    } else if (message.type === "asterion:chunk-failed") {
      pendingCommits.get(`${message.sessionId}:${message.stream}:${message.generation}:${message.seq}`)?.({ committed: false });
      if (session?.sessionId === message.sessionId) rtcPatchLog("chunk-persistence-error", { generation: message.generation, seq: message.seq, message: message.message });
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
      await session?.stop();
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

      debugLog("[Ariadne] userActivation.isActive antes de getDisplayMedia:", navigator.userActivation?.isActive);

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
    const snapshot = { htmlAudio: htmlObserver.getSnapshot(), localAudio: mixer.getLocalSnapshot(), recordingType: mixer.recordingType, recorder: session ? { restarts: session.generation, generation: session.generation, state: session.meetingRecorder?.state, receivedChunks: session.receivedChunks, committedChunks: session.committedChunks } : null, timestampMs: Date.now(), remoteAudio, mediaElements, receivers: await inspectRemoteReceivers() };
    debugEvent("audio-flow-inspection", snapshot);
    return snapshot;
  };
  diagnostics.getRemoteAudioSnapshot = () => ({ ...remoteAudioMonitor.getRemoteAudioSnapshot(),
    htmlAudio: htmlObserver.getSnapshot(), localAudio: mixer.getLocalSnapshot(),
    recorder: session ? { generation: session.generation, state: session.meetingRecorder?.state, receivedChunks: session.receivedChunks, committedChunks: session.committedChunks } : null,
    recovery: health.getSnapshot(),
  });
  window.__asterionDiagnostics = diagnostics;

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") health.check(false); });

}
