// src/storage/session-writer.js
import { loadRootDirectoryHandle } from "./directory-handle-store.js";
import { CaptionParser } from "../lib/caption-parser.js";

const STREAM_FILE_NAMES = {
  meeting: "audio-reunion.webm",
  mic: "audio-propio.webm",
  video: "video-reunion.webm",
};

function meetingFolderName(startedAt) {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `reunion-${iso}`;
}

export class SessionWriter {
  constructor({ sessionId, tabId }) {
    this.sessionId = sessionId;
    this.tabId = tabId;
    this.startedAt = Date.now();
    this.writablesByStream = new Map();
    this.captionParser = new CaptionParser();
    this.hasCaption = false;
    this.streamsUsed = new Set();
    this.ready = this._init();
  }

  async _init() {
    const rootHandle = await loadRootDirectoryHandle();
    if (!rootHandle) {
      throw new Error("No hay carpeta raíz configurada. Abrí el popup de Asterion y elegila.");
    }
    const permission = await rootHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      throw new Error("El permiso de la carpeta raíz ya no está activo. Volvé a elegirla desde el popup.");
    }
    this.meetingHandle = await rootHandle.getDirectoryHandle(meetingFolderName(this.startedAt), {
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

  async writeChunk(streamLabel, buffer) {
    const writable = await this._getWritable(streamLabel);
    await writable.write(buffer);
  }

  onCaptionSnapshot(snapshot) {
    this.hasCaption = true;
    this.captionParser.onSnapshot(snapshot);
  }

  async finalize({ muteManifest }) {
    await this.ready;
    this.captionParser.finalizeCurrent(Date.now());

    for (const writable of this.writablesByStream.values()) {
      await writable.close();
    }

    if (this.hasCaption) {
      const transcriptText = this.captionParser.finishedSegments
        .map((segment) => `[${segment.speaker}] ${segment.text}`)
        .join("\n");
      const fileHandle = await this.meetingHandle.getFileHandle("transcripcion.txt", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(transcriptText);
      await writable.close();
    }

    const manifestHandle = await this.meetingHandle.getFileHandle("manifest.json", { create: true });
    const manifestWritable = await manifestHandle.createWritable();
    await manifestWritable.write(
      JSON.stringify(
        {
          startedAt: this.startedAt,
          hasTranscript: this.hasCaption,
          hasVideo: this.streamsUsed.has("video"),
          muteManifest,
        },
        null,
        2
      )
    );
    await manifestWritable.close();

    return {
      sessionId: this.sessionId,
      tabId: this.tabId,
      folderName: this.meetingHandle.name,
      startedAt: this.startedAt,
      hasTranscript: this.hasCaption,
      hasVideo: this.streamsUsed.has("video"),
    };
  }
}
