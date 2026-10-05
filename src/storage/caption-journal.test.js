import { describe, it, expect } from "vitest";
import { MemoryDirectoryHandle } from "../../tests/helpers/memory-opfs.js";
import { CaptionJournal } from "./caption-journal.js";
const event = { sessionId: "s", source: "dom", utteranceId: "1", eventSeq: 1, revision: 1,
  speaker: "Ana", speakerId: null, text: "Hola", firstReceivedAt: 1, updatedAt: 1 };
describe("durable caption journal", () => {
  it("acknowledges only closed files, replays after restart and rejects conflicting sequence", async () => {
    const directory = new MemoryDirectoryHandle("meeting");
    const journal = await CaptionJournal.open(directory, "s");
    expect(await journal.append(event)).toMatchObject({ durable: true, eventSeq: 1 });
    const restored = await CaptionJournal.open(directory, "s");
    expect(restored.model.values()[0].text).toBe("Hola");
    expect(await restored.append(event)).toMatchObject({ duplicate: true });
    await expect(restored.append({ ...event, text: "Conflicto" })).rejects.toThrow("Conflicting");
    expect(restored.snapshot(3).gaps).toEqual([2, 3]);
  });
  it("does not acknowledge a failed write and permits retry", async () => {
    const journal = await CaptionJournal.open(new MemoryDirectoryHandle("meeting"), "s");
    const file = await journal.records.getFileHandle("1.json", { create: true });
    const original = file.createWritable.bind(file);
    file.createWritable = async () => { throw new Error("disk error"); };
    await expect(journal.append(event)).rejects.toThrow("disk error");
    expect(journal.events.size).toBe(0); file.createWritable = original;
    await journal.append(event); expect(journal.events.size).toBe(1);
  });
});

it("durably restores late local identity, raw labels and unchanged offsets", async () => {
  const dir = new MemoryDirectoryHandle("meeting"), journal = await CaptionJournal.open(dir, "s");
  await journal.append({ ...event, speaker: "You", originalSpeaker: "You", isSelf: true });
  const identityEvent = { sessionId: "s", eventSeq: 2, kind: "local-identity", identity: {
    speakerId: "own", name: "Iván", evidence: "meet-own-camera-controls" } };
  await journal.append(identityEvent);
  const restored = await CaptionJournal.open(dir, "s");
  expect(await restored.append(identityEvent)).toMatchObject({ duplicate: true });
  expect(restored.model.segments(0, 10)[0]).toMatchObject({ speaker: "Iván (you)", startTime: 1, endTime: 1 });
  expect(restored.model.values()[0].originalSpeaker).toBe("You");
  expect(restored.snapshot(2).gaps).toEqual([]);
  await expect(restored.append({ ...identityEvent, eventSeq: 3, identity: { ...identityEvent.identity, evidence: "guess" } })).rejects.toThrow("Invalid");
});
it("continues reading version two caption records", async () => {
  const dir = new MemoryDirectoryHandle("meeting"), records = await dir.getDirectoryHandle("caption-records", { create: true });
  const file = await records.getFileHandle("1.json", { create: true }), writable = await file.createWritable();
  await writable.write(JSON.stringify({ version: 2, event })); await writable.close();
  const journal = await CaptionJournal.open(dir, "s"); expect(journal.model.values()[0].text).toBe("Hola");
});
