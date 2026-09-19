// src/storage/session-writer.js
import { CaptionParser } from "../lib/caption-parser.js";
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
  return `${sanitizeForFolderName(meetingTitle)} — ${iso}`;
}

function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
    this.hasCaption = false;
    this.streamsUsed = new Set();
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
    this.captionParser.onSnapshot(snapshot);
  }

  async finalize({ muteManifest, endedAt }) {
    // Se usa el momento real en que el usuario detuvo la grabación (capturado en
    // MainWorldSession.stop()), no cuándo finalize() llegó a ejecutarse acá —
    // entre medio hay envíos de mensajes y cierres de archivo que pueden demorar.
    this.endedAt = endedAt ?? Date.now();
    await this.ready;
    this.captionParser.finalizeCurrent(Date.now());

    await Promise.all(this.writeQueueByStream.values());

    for (const writable of this.writablesByStream.values()) {
      await writable.close();
    }

    if (this.hasCaption) {
      const transcriptText = this.captionParser.finishedSegments
        .map((segment) => `[${formatTimestamp(segment.startMs)}] [${segment.speaker}] ${segment.text}`)
        .join("\n");
      const fileHandle = await this.meetingHandle.getFileHandle("transcripcion.txt", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(transcriptText);
      await writable.close();
    }

    this.hasVideo = this.streamsUsed.has("video");
    await this._writeManifest({
      muteManifest,
      audioConversionStatus: this.streamsUsed.has("meeting") ? "pending" : "skipped",
      videoConversionStatus: this.hasVideo ? "pending" : "skipped",
    });

    // No se espera esta promesa — la sesión ya se considera "finalizada" con los
    // webm originales a salvo; la conversión sigue en segundo plano y actualiza
    // el manifest cuando termina (éxito o fallo).
    this.scheduleConversions(muteManifest, this.endedAt);

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
          console.error("[Asterion] Falló la conversión de audio a MP3 (el webm original queda intacto):", error);
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
          console.error("[Asterion] No se pudo obtener el preset de video guardado, se usa 'medium' por defecto:", error);
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
          console.error("[Asterion] Falló la conversión de video a MP4 (el webm original queda intacto):", error);
          videoConversionStatus = "failed";
        }
        await this._writeManifest({ muteManifest, audioConversionStatus, videoConversionStatus, hasAudioMp3, hasVideoMp4 });
      }
    } catch (error) {
      console.error("[Asterion] Falló inesperadamente la programación de conversiones:", error);
    } finally {
      sendConversionMessage({ type: "asterion:conversion-finished", sessionId: this.sessionId });
      try {
        await this.onConversionsFinished?.();
      } catch (error) {
        console.error("[Asterion] Falló el callback de finalización de conversiones:", error);
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
