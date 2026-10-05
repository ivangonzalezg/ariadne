export const CAPTURE_FORMAT_VERSION = 1;
export const CAPTURE_STATE_FILE = "capture-state.json";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const recordName = (stream, generation, seq) => `${stream}-${generation}-${seq}.chunk`;
const invalid = (message) => Object.assign(new Error(message), { retryable: false, code: "INVALID_DATA" });

export async function writeFile(directory, name, bytes, signal) {
  const handle = await directory.getFileHandle(name, { create: true });
  let writable;
  try {
    if (signal?.aborted) throw new Error("Obsolete conversion attempt");
    writable = await handle.createWritable();
    await writable.write(bytes);
    if (signal?.aborted) throw new Error("Obsolete conversion attempt");
    await writable.close();
  } catch (error) { await writable?.abort?.().catch(() => {}); throw error; }
}

export async function readJson(directory, name) {
  const file = await (await directory.getFileHandle(name)).getFile();
  return JSON.parse(decoder.decode(await file.arrayBuffer()));
}

async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class CaptureJournal {
  constructor(directory, state) {
    this.directory = directory;
    this.state = state;
    this.records = new Map();
    this.queue = Promise.resolve();
  }

  static async open(directory, initialState = null) {
    const state = initialState ?? await readJson(directory, CAPTURE_STATE_FILE);
    if (state.version !== CAPTURE_FORMAT_VERSION || !state.sessionId || state.folderName !== directory.name) throw invalid("Invalid capture state");
    const journal = new CaptureJournal(directory, state);
    journal.recordsDirectory = await directory.getDirectoryHandle("capture-records", { create: true });
    if (initialState) await journal.checkpoint({});
    else {
      state.invalidRecords = [];
      for await (const handle of journal.recordsDirectory.values()) {
        if (handle.kind !== "file" || !handle.name.endsWith(".chunk")) continue;
        try {
          const { header } = await journal.readRecord(handle.name);
          journal.records.set(handle.name, header);
        } catch (error) {
          const identity = /^(meeting|video)-\d+-(\d+)\.chunk$/.exec(handle.name);
          if (identity) {
            state.expectedSequences ??= {};
            state.expectedSequences[identity[1]] = Math.max(state.expectedSequences[identity[1]] ?? 0, Number(identity[2]));
          }
          state.invalidRecords.push({ name: handle.name, error: error.message });
          state.invalidRecords = state.invalidRecords.slice(-100);
        }
      }
    }
    return journal;
  }

  checkpoint(update) {
    const operation = this.queue.then(async () => {
      Object.assign(this.state, update);
      await writeFile(this.directory, CAPTURE_STATE_FILE, JSON.stringify(this.state));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async readRecord(name) {
    const bytes = new Uint8Array(await (await this.recordsDirectory.getFileHandle(name)).getFile().then((file) => file.arrayBuffer()));
    if (bytes.length < 5) throw invalid("Truncated chunk record");
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
    if (headerLength < 1 || headerLength > 65536 || headerLength + 4 > bytes.length) throw invalid("Invalid chunk header length");
    let header;
    try { header = JSON.parse(decoder.decode(bytes.subarray(4, 4 + headerLength))); }
    catch { throw invalid("Invalid chunk header JSON"); }
    this.validateIdentity(header);
    const payload = bytes.subarray(4 + headerLength);
    if (header.byteLength !== payload.length || header.sha256 !== await digest(payload) ||
        name !== recordName(header.stream, header.generation, header.seq)) throw invalid("Chunk checksum or identity mismatch");
    return { header, payload };
  }

  validateIdentity(header) {
    if (header.version !== CAPTURE_FORMAT_VERSION || header.sessionId !== this.state.sessionId ||
        !["meeting", "video"].includes(header.stream) || !Number.isSafeInteger(header.seq) || header.seq < 1 ||
        !Number.isSafeInteger(header.generation) || header.generation < 0 || !Number.isFinite(header.captureTs)) throw invalid("Invalid chunk identity");
  }

  async append(stream, buffer, metadata) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const header = { ...metadata, version: CAPTURE_FORMAT_VERSION, sessionId: this.state.sessionId, stream, byteLength: bytes.byteLength };
    if (metadata.sessionId && metadata.sessionId !== header.sessionId) throw invalid("Session mismatch");
    this.validateIdentity(header);
    if (!bytes.length) throw invalid("Empty chunk");
    header.sha256 = await digest(bytes);
    const name = recordName(stream, header.generation, header.seq);
    let existing;
    try { existing = await this.readRecord(name); }
    catch (error) {
      if (this.records.has(name) || (error.code !== "INVALID_DATA" && error.name !== "NotFoundError")) throw error;
      // An invalid unfinished record was never acknowledged and can be repaired.
    }
    if (existing) {
      if (existing.header.sha256 !== header.sha256 || existing.header.captureTs !== header.captureTs) throw invalid("Conflicting duplicate chunk");
      this.records.set(name, existing.header);
      return { durable: true, duplicate: true, ...existing.header, ...this.snapshot(stream) };
    }
    for (const known of this.records.values()) {
      if (known.stream === stream && ((known.seq < header.seq && known.generation > header.generation) ||
          (known.seq > header.seq && known.generation < header.generation))) throw invalid("Invalid generation order");
    }
    // Sequence identity is unique across recorder generations as well.
    if ([...this.records.values()].some((item) => item.stream === stream && item.seq === header.seq)) throw invalid("Conflicting chunk generation");
    const encoded = encoder.encode(JSON.stringify(header));
    const record = new Uint8Array(4 + encoded.length + bytes.length);
    new DataView(record.buffer).setUint32(0, encoded.length, false);
    record.set(encoded, 4); record.set(bytes, 4 + encoded.length);
    for (let attempt = 0; ; attempt++) {
      try { await writeFile(this.recordsDirectory, name, record); break; }
      catch (error) {
        if (error.name === "QuotaExceededError") { error.retryable = false; throw error; }
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    this.records.set(name, header);
    return { durable: true, duplicate: false, ...header, ...this.snapshot(stream) };
  }

  snapshot(stream) {
    const headers = [...this.records.values()].filter((header) => header.stream === stream).sort((a, b) => a.seq - b.seq);
    const highest = Math.max(this.state.expectedSequences?.[stream] ?? 0, headers.at(-1)?.seq ?? 0);
    const sequences = new Set(headers.map((header) => header.seq));
    const gaps = [];
    for (let seq = 1; seq <= highest; seq++) if (!sequences.has(seq)) gaps.push(seq);
    return { lastCommitAt: headers.length ? Math.max(...headers.map((header) => header.committedAt ?? header.captureTs)) : null,
      confirmedSequences: headers.map((header) => header.seq), pendingSequences: gaps, gaps };
  }

  async materialize(stream, { prefix = false, signal } = {}) {
    const headers = [...this.records.values()].filter((header) => header.stream === stream).sort((a, b) => a.seq - b.seq);
    const segments = [];
    let expected = 1;
    for (const header of headers) {
      if (header.seq !== expected) { if (prefix) break; throw invalid("Missing chunk sequence"); }
      if (signal?.aborted) throw new Error("Obsolete processing attempt");
      try { await this.readRecord(recordName(stream, header.generation, header.seq)); }
      catch (error) {
        if (!prefix || (error.code !== "INVALID_DATA" && error.name !== "NotFoundError")) throw error;
        this.state.invalidRecords ??= [];
        this.state.invalidRecords.push({ name: recordName(stream, header.generation, header.seq), error: error.message });
        break;
      }
      expected++;
      let segment = segments.at(-1);
      if (!segment || segment.generation !== header.generation) {
        if (segment && header.generation <= segment.generation) {
          if (!prefix) throw invalid("Invalid generation order");
          this.state.invalidRecords ??= [];
          this.state.invalidRecords.push({ name: recordName(stream, header.generation, header.seq), error: "Invalid generation order" });
          break;
        }
        segment = { stream, generation: header.generation, name: `${stream}-segment-${header.generation}.webm`,
          firstSequence: header.seq, firstCaptureTs: header.captureTs, byteLength: 0, records: [] };
        segments.push(segment);
      }
      segment.records.push(recordName(stream, header.generation, header.seq)); segment.byteLength += header.byteLength;
      segment.lastSequence = header.seq; segment.lastCaptureTs = header.captureTs;
    }
    if (!prefix && this.snapshot(stream).gaps.length) throw invalid("Missing chunk sequence");
    for (const segment of segments) {
      const file = await this.directory.getFileHandle(segment.name, { create: true });
      const writable = await file.createWritable();
      try {
        let offset = 0;
        for (const name of segment.records) {
          if (signal?.aborted) throw new Error("Obsolete processing attempt");
          const { payload } = await this.readRecord(name);
          await writable.write({ type: "write", position: offset, data: payload });
          offset += payload.length;
        }
        if (signal?.aborted) throw new Error("Obsolete processing attempt");
        await writable.close();
      } catch (error) { await writable.abort?.().catch(() => {}); throw error; }
      delete segment.records;
    }
    if (segments.length === 1) {
      const bytes = await (await this.directory.getFileHandle(segments[0].name)).getFile();
      await writeFile(this.directory, stream === "meeting" ? "audio-reunion.webm" : "video-reunion.webm", bytes, signal);
    }
    return segments;
  }
}
