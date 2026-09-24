// src/webrtc-bootstrap/bootstrap.js
import {
  installRtcPatch,
  installGetUserMediaPatch,
  installReplaceTrackPatch,
  getCurrentLocalAudioTrack,
  diagnostics,
} from "./rtc-patch.js";
import { MeetingAudioMixer } from "./audio-mixer.js";
import { MainWorldSession } from "./session.js";
import { startSpeakerObserver } from "./speaker-observer.js";
import { installCaptionsDataChannelPatch } from "./caption-datachannel-patch.js";
import { createCaptionAssembler } from "./caption-assembler.js";
import { debugDebug, debugLog, setDebugEnabled } from "../shared/debug-log.js";

const rtcPatchLog = (event, details) => debugDebug(`[Ariadne:rtc-patch] ${event}`, details);

const mixer = new MeetingAudioMixer({
  log: (event, details) => debugDebug(`[Ariadne:audio-mixer] ${event}`, details),
});
mixer.resume().catch(() => {});
let micTrack = null;
let session = null;
let currentlyMuted = false;
let stopSpeakerObserver = () => {};

const captionAssembler = createCaptionAssembler({
  onCaptionFinalized: ({ captionId, deviceSpace, text, endMs }) => {
    if (!session) return;
    postToIsolated({
      type: "asterion:caption-snapshot",
      sessionId: session.sessionId,
      snapshot: {
        speaker: "unknown",
        text,
        timestampMs: endMs,
        captionId: `${deviceSpace}:${captionId}`,
      },
    });
  },
});

installRtcPatch({
  onRemoteAudioTrack: (payload) => mixer.addRemoteTrack(payload),
  onConnectionClosed: (connectionId) => mixer.removeConnection(connectionId),
  log: rtcPatchLog,
});

installGetUserMediaPatch({
  onMicStream: (stream, audioTrack) => {
    micTrack = audioTrack;
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
    micTrack = newTrack;
    if (session) {
      // Grabación en curso: no alcanza con actualizar `micTrack` para la
      // próxima vez - hay que reconectar el mixer YA con el track nuevo, o
      // seguiríamos mezclando el viejo hasta el final de la sesión.
      //
      // Límite conocido, no resuelto en este plan: MeetingAudioMixer.setMicTrack()
      // desconecta el nodo de audio viejo y conecta uno nuevo de forma directa
      // (sin rampa), a diferencia de setMicMuted(), que sí usa una rampa corta
      // para evitar un "click" audible. Un reemplazo de track en vivo podría
      // sonar con un salto/click perceptible en el archivo grabado. No se
      // agrega una rampa acá todavía porque no hay evidencia de que esto pase
      // en la práctica (un replaceTrack en vivo, a mitad de una grabación, es
      // el caso menos común de los que este plan cubre) - si la verificación
      // manual (Tarea 3) confirma que sí se nota, esa rampa es el siguiente
      // paso, no algo para adivinar ahora.
      mixer.setMicTrack(newTrack, { initiallyMuted: currentlyMuted });
    }
  },
  log: rtcPatchLog,
});

installCaptionsDataChannelPatch({
  onCaptionMessage: captionAssembler.onCaptionMessage,
  log: rtcPatchLog,
});

function postToIsolated(message, transfer = []) {
  window.postMessage({ source: "asterion-main-world", ...message }, "*", transfer);
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "asterion-isolated-world") return;

  debugLog("[Ariadne:debug] mensaje recibido desde ISOLATED world", { type: message.type });

  if (message.type === "asterion:start-session") {
    captionAssembler.reset();
    setDebugEnabled(message.debugLogging);
    debugLog("[Ariadne:debug] asterion:start-session recibido; se intentará crear MainWorldSession e iniciar mixer", {
      sessionId: message.sessionId,
      mixer,
      session,
    });
    // Se prefiere el track que la conexión ACTIVA está enviando ahora mismo
    // (por si Meet ya reemplazó el original antes de que arrancara la
    // grabación) por sobre el que getUserMedia devolvió una sola vez al
    // principio. Si por algo no hay ninguna conexión con un sender de audio
    // todavía (p. ej. la reunión recién está arrancando), se cae al track de
    // getUserMedia como venía haciendo antes.
    const liveAudioTrack = getCurrentLocalAudioTrack({ log: rtcPatchLog });
    const trackToUse = liveAudioTrack ?? micTrack;
    currentlyMuted = Boolean(message.initialMicMuted);
    rtcPatchLog("mic-track-resolved-for-session-start", {
      source: liveAudioTrack ? "sender-lookup" : "getUserMedia-fallback",
      trackId: trackToUse?.id ?? null,
    });
    if (!trackToUse) {
      postToIsolated({ type: "asterion:start-failed", sessionId: message.sessionId, reason: "no-mic-stream" });
      return;
    }
    mixer.setMicTrack(trackToUse, { initiallyMuted: currentlyMuted });
    debugLog("[Ariadne] AudioContext state antes de resume():", mixer.audioContext.state);
    await mixer.resume();
    debugLog("[Ariadne] AudioContext state después de resume():", mixer.audioContext.state);
    session = new MainWorldSession({
      sessionId: message.sessionId,
      mixer,
      postToIsolated,
      initialMicMuted: Boolean(message.initialMicMuted),
    });
    session.start();
    mixer.startReconciliation();
    postToIsolated({ type: "asterion:session-started", sessionId: message.sessionId });
    stopSpeakerObserver = startSpeakerObserver({
      onSpeakerLabel: (label) => postToIsolated({ type: "asterion:speaker-label", sessionId: message.sessionId, label }),
      log: rtcPatchLog,
    });
  } else if (message.type === "asterion:mic-muted") {
    currentlyMuted = true;
    session?.onMicMuted(message.timestampMs);
  } else if (message.type === "asterion:mic-unmuted") {
    currentlyMuted = false;
    session?.onMicUnmuted(message.timestampMs);
  } else if (message.type === "asterion:stop-session") {
    // Flush before clearing the active session so a pending v1 caption is
    // delivered to the isolated world instead of being discarded by the gate.
    captionAssembler.flush();
    session?.stop();
    session = null;
    mixer.stopReconciliation();
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

window.__asterionDiagnostics = diagnostics;
