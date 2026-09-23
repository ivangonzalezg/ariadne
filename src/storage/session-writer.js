// src/storage/session-writer.js
import { CaptionParser } from "../lib/caption-parser.js";
import { reconcileCaptionSnapshots } from "../lib/speaker-label-reconciler.js";
import { runFfmpegJob } from "../offscreen/ffmpeg-client.js";

const STREAM_FILE_NAMES = {
  meeting: "audio-reunion.webm",
  video: "video-reunion.webm",
};

function sanitizeForFolderName(text) {
  return text.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80).trim() || "Reunión";
}

function meetingFolderName(startedAt, meetingTitle) {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `${sanitizeForFolderName(meetingTitle)} - ${iso}`;
}

function sendConversionMessage(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // La señal de progreso no debe interrumpir la conversión real.
  }
}

export class SessionWriter {
  constructor({ sessionId, tabId, meetingTitle }) {
    this.sessionId = sessionId;
    this.tabId = tabId;
    this.meetingTitle = meetingTitle || "Reunión sin título";
    this.startedAt = Date.now();
    this.writablesByStream = new Map();
    this.writeQueueByStream = new Map();
    this.captionParser = new CaptionParser();
    this.captionSnapshots = [];
    this.speakerLabels = [];
    this.hasCaption = false;
    this.streamsUsed = new Set();
    this._finalizePromise = null;
    this.ready = this._init();
  }

  async _init() {
    const root = await navigator.storage.getDirectory();
    this.meetingHandle = await root.getDirectoryHandle(meetingFolderName(this.startedAt, this.meetingTitle), {
      create: true,
    });
  }

  async _getWritable(streamLabel) {
    await this.ready;
    if (this.writablesByStream.has(streamLabel)) {
      return this.writablesByStream.get(streamLabel);
    }
    const fileName = STREAM_FILE_NAMES[streamLabel];
    const fileHandle = await this.meetingHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    this.writablesByStream.set(streamLabel, writable);
    this.streamsUsed.add(streamLabel);
    return writable;
  }

  writeChunk(streamLabel, buffer) {
    // Encadenar por stream: una escritura no arranca antes de que termine la
    // anterior del mismo archivo, y finalize() espera a que esta cola se vacíe
    // antes de cerrar los streams (si no, se podía cortar el último chunk).
    const previous = this.writeQueueByStream.get(streamLabel) ?? Promise.resolve();
    const next = previous.then(async () => {
      const writable = await this._getWritable(streamLabel);
      await writable.write(buffer);
    });
    this.writeQueueByStream.set(streamLabel, next);
    return next;
  }

  onCaptionSnapshot(snapshot) {
    this.hasCaption = true;
    this.captionSnapshots.push(snapshot);
  }

  onSpeakerLabel(label) {
    this.speakerLabels.push(label);
  }

  finalize(args) {
    if (!this._finalizePromise) this._finalizePromise = this._finalizeOnce(args);
    return this._finalizePromise;
  }

  async _finalizeOnce({ muteManifest, endedAt }) {
    // Cuando la sesión se finaliza desde un camino de emergencia (cierre de
    // pestaña/navegación, ver service-worker.js) no hay forma de reconstruir
    // el historial real de mute/unmute — vivía en la pestaña que ya se fue.
    // degraded:true dice explícitamente "no se pudo reconstruir este dato",
    // nunca "el mic nunca se desmuteó" (que sería lo que {intervals: []}
    // solo, sin la marca, parecería implicar).
    const resolvedMuteManifest = muteManifest ?? { intervals: [], degraded: true };
    // Se usa el momento real en que el usuario detuvo la grabación (capturado en
    // MainWorldSession.stop()), no cuándo finalize() llegó a ejecutarse acá -
    // entre medio hay envíos de mensajes y cierres de archivo que pueden demorar.
    this.endedAt = endedAt ?? Date.now();
    await this.ready;

    await Promise.all(this.writeQueueByStream.values());

    for (const writable of this.writablesByStream.values()) {
      await writable.close();
    }

    if (this.hasCaption) {
      const reconciled = reconcileCaptionSnapshots({
        captions: this.captionSnapshots,
        speakerLabels: this.speakerLabels,
      });
      for (const snapshot of reconciled) {
        this.captionParser.onSnapshot(snapshot);
      }
      this.captionParser.finalizeCurrent(this.endedAt);

      // segment.startMs/endMs son epoch absoluto (Date.now() en meet-caption-observer.js);
      // se restan contra startedAt para guardar offsets relativos al inicio de la
      // grabación, iguales a los que usa el resto del manifest.
      const segments = this.captionParser.finishedSegments.map((segment, index) => ({
        index,
        startTime: segment.startMs - this.startedAt,
        endTime: segment.endMs - this.startedAt,
        text: segment.text,
        speaker: segment.speaker,
      }));
      const fileHandle = await this.meetingHandle.getFileHandle("transcripcion.json", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(segments, null, 2));
      await writable.close();
    }

    this.hasVideo = this.streamsUsed.has("video");
    await this._writeManifest({
      muteManifest: resolvedMuteManifest,
      audioConversionStatus: this.streamsUsed.has("meeting") ? "pending" : "skipped",
      videoConversionStatus: this.hasVideo ? "pending" : "skipped",
    });

    // No se espera esta promesa - la sesión ya se considera "finalizada" con los
    // webm originales a salvo; la conversión sigue en segundo plano y actualiza
    // el manifest cuando termina (éxito o fallo).
    this.scheduleConversions(resolvedMuteManifest, this.endedAt);

    return {
      sessionId: this.sessionId,
      tabId: this.tabId,
      folderName: this.meetingHandle.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.endedAt - this.startedAt,
      meetingTitle: this.meetingTitle,
      hasTranscript: this.hasCaption,
      hasVideo: this.hasVideo,
    };
  }

  async _writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 }) {
    const manifestHandle = await this.meetingHandle.getFileHandle("manifest.json", { create: true });
    const manifestWritable = await manifestHandle.createWritable();
    await manifestWritable.write(
      JSON.stringify(
        {
          startedAt: this.startedAt,
          endedAt: this.endedAt,
          durationMs: this.endedAt - this.startedAt,
          meetingTitle: this.meetingTitle,
          hasTranscript: this.hasCaption,
          hasVideo: this.hasVideo,
          muteManifest,
          audioConversionStatus,
          videoConversionStatus,
          hasAudioMp3: hasAudioMp3 ?? false,
          hasVideoMp4: hasVideoMp4 ?? false,
        },
        null,
        2
      )
    );
    await manifestWritable.close();
  }

  async scheduleConversions(muteManifest, endedAt) {
    let audioConversionStatus = this.streamsUsed.has("meeting") ? "pending" : "skipped";
    let videoConversionStatus = this.hasVideo ? "pending" : "skipped";
    let hasAudioMp3 = false;
    let hasVideoMp4 = false;
    const knownDurationMs = Math.max(1, endedAt - this.startedAt);

    const createProgressReporter = (stream) => {
      let lastSentPct = 0;
      let lastSentAt = Date.now();
      let lastTimeMs = -Infinity;

      return (timeMs) => {
        if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs < lastTimeMs) return;
        lastTimeMs = timeMs;

        const pct = Math.min(100, Math.max(0, Math.round((timeMs / knownDurationMs) * 100)));
        const now = Date.now();
        if (pct === lastSentPct || now - lastSentAt < 500) return;

        lastSentPct = pct;
        lastSentAt = now;
        sendConversionMessage({ type: "asterion:conversion-progress", sessionId: this.sessionId, stream, pct });
      };
    };

    try {
      if (this.streamsUsed.has("meeting")) {
        sendConversionMessage({
          type: "asterion:conversion-started",
          sessionId: this.sessionId,
          meetingTitle: this.meetingTitle,
          stream: "meeting",
        });
        try {
          await this._convertStream({
            sourceFileName: STREAM_FILE_NAMES.meeting,
            targetFileName: "audio-reunion.mp3",
            inputExt: "webm",
            outputExt: "mp3",
            args: ["-vn"],
            onProgress: createProgressReporter("meeting"),
          });
          audioConversionStatus = "succeeded";
          hasAudioMp3 = true;
        } catch (error) {
          console.error("[Ariadne] Falló la conversión de audio a MP3 (el webm original queda intacto):", error);
          audioConversionStatus = "failed";
        }
        await this._writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 });
      }

      if (this.hasVideo) {
        let videoPreset = "medium";
        try {
          const response = await chrome.runtime.sendMessage({ type: "asterion:get-video-preset" });
          if (response?.videoPreset) videoPreset = response.videoPreset;
        } catch (error) {
          console.error("[Ariadne] No se pudo obtener el preset de video guardado, se usa 'medium' por defecto:", error);
        }
        sendConversionMessage({
          type: "asterion:conversion-started",
          sessionId: this.sessionId,
          meetingTitle: this.meetingTitle,
          stream: "video",
        });
        try {
          await this._convertStream({
            sourceFileName: STREAM_FILE_NAMES.video,
            targetFileName: "video-reunion.mp4",
            inputExt: "webm",
            outputExt: "mp4",
            args: ["-fps_mode", "vfr", "-preset", videoPreset],
            onProgress: createProgressReporter("video"),
          });
          videoConversionStatus = "succeeded";
          hasVideoMp4 = true;
        } catch (error) {
          console.error("[Ariadne] Falló la conversión de video a MP4 (el webm original queda intacto):", error);
          videoConversionStatus = "failed";
        }
        await this._writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 });
      }
    } catch (error) {
      console.error("[Ariadne] Falló inesperadamente la programación de conversiones:", error);
    } finally {
      sendConversionMessage({ type: "asterion:conversion-finished", sessionId: this.sessionId });
      try {
        await this.onConversionsFinished?.();
      } catch (error) {
        console.error("[Ariadne] Falló el callback de finalización de conversiones:", error);
      }
    }
  }

  async _convertStream({ sourceFileName, targetFileName, inputExt, outputExt, args, onProgress }) {
    const sourceHandle = await this.meetingHandle.getFileHandle(sourceFileName);
    const sourceFile = await sourceHandle.getFile();
    const inputBytes = new Uint8Array(await sourceFile.arrayBuffer());
    const outputBytes = await runFfmpegJob({ inputBytes, inputExt, outputExt, args, onProgress });
    const targetHandle = await this.meetingHandle.getFileHandle(targetFileName, { create: true });
    const targetWritable = await targetHandle.createWritable();
    await targetWritable.write(outputBytes);
    await targetWritable.close();
  }
}
