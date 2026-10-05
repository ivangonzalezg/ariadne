import { CAPTION_FORMAT_VERSION, CaptionModel, validateCaptionEvent } from "../lib/caption-model.js";
import { readJson, writeFile } from "./capture-journal.js";

export class CaptionJournal {
  constructor(directory, sessionId) {
    this.directory = directory; this.sessionId = sessionId; this.events = new Map();
    this.model = new CaptionModel(); this.queue = Promise.resolve(); this.errors = [];
  }
  static async open(directory, sessionId) {
    const journal = new CaptionJournal(directory, sessionId);
    journal.records = await directory.getDirectoryHandle("caption-records", { create: true });
    for await (const file of journal.records.values()) {
      if (file.kind !== "file" || !/^\d+\.json$/.test(file.name)) continue;
      try {
        const { version, event } = await readJson(journal.records, file.name);
        validateCaptionEvent(event, sessionId);
        if (![2, CAPTION_FORMAT_VERSION].includes(version) || file.name !== `${event.eventSeq}.json`) throw new Error("Invalid caption record");
        journal.events.set(event.eventSeq, event);
      } catch (error) { journal.errors.push({ record: file.name, message: error.message }); }
    }
    for (const event of [...journal.events.values()].sort((a, b) => a.eventSeq - b.eventSeq)) journal.model.apply(event);
    return journal;
  }
  append(event) {
    const copy = structuredClone(event);
    const operation = this.queue.then(async () => {
      validateCaptionEvent(copy, this.sessionId);
      const existing = this.events.get(copy.eventSeq);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(copy)) throw Object.assign(new Error("Conflicting caption sequence"), { retryable: false });
        return { durable: true, eventSeq: copy.eventSeq, duplicate: true };
      }
      await writeFile(this.records, `${copy.eventSeq}.json`, JSON.stringify({ version: CAPTION_FORMAT_VERSION, event: copy }));
      this.errors = this.errors.filter(error => error.record !== `${copy.eventSeq}.json`);
      this.events.set(copy.eventSeq, copy); this.model.apply(copy);
      return { durable: true, eventSeq: copy.eventSeq, duplicate: false };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  snapshot(expected = 0) {
    const highest = Math.max(expected, ...this.events.keys(), 0), gaps = [];
    for (let seq = 1; seq <= highest; seq++) if (!this.events.has(seq)) gaps.push(seq);
    return { committed: this.events.size, gaps, errors: this.errors, discardedRevisions: this.model.discarded };
  }
}
