import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { Blob } from "node:buffer";
import { MemoryDirectoryHandle } from "../../tests/helpers/memory-opfs.js";
import { CaptureJournal, writeFile } from "./capture-journal.js";
let directory;
const open = () => CaptureJournal.open(directory, { version: 1, sessionId: "one", folderName: "meeting", expectedSequences: {} });
const append = (journal, seq, bytes = [seq], generation = 0) => journal.append("meeting", new Uint8Array(bytes), { seq, generation, captureTs: seq * 1000 });
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", Blob); directory = new MemoryDirectoryHandle("meeting"); });
describe("immutable capture records", () => {
  it("persists later chunks through a gap, restores it, and reconstructs only after retransmission", async () => {
    const journal = await open();
    await append(journal, 1); await append(journal, 3);
    await expect(journal.materialize("meeting")).rejects.toThrow("Missing chunk sequence");
    const restored = await CaptureJournal.open(directory);
    expect(restored.snapshot("meeting").gaps).toEqual([2]);
    expect((await restored.materialize("meeting", { prefix: true }))[0].lastSequence).toBe(1);
    await append(restored, 2);
    await restored.materialize("meeting");
    expect([...directory.files.get("audio-reunion.webm").bytes]).toEqual([1, 2, 3]);
  });
  it("recovers a lost ACK without changing bytes and rejects a conflicting duplicate", async () => {
    const journal = await open(); const ack = await append(journal, 1);
    const record = journal.recordsDirectory.files.get("meeting-0-1.chunk");
    const before = record.bytes.slice(); const write = vi.spyOn(record, "createWritable");
    const restored = await CaptureJournal.open(directory);
    expect(await append(restored, 1)).toMatchObject({ durable: true, duplicate: true, sha256: ack.sha256 });
    expect(write).not.toHaveBeenCalled(); expect(record.bytes).toEqual(before);
    await expect(append(restored, 1, [99])).rejects.toThrow("Conflicting duplicate");
  });
  it("does not acknowledge an interrupted close and repairs its invalid record", async () => {
    const journal = await open();
    await writeFile(journal.recordsDirectory, "meeting-0-1.chunk", new Uint8Array([1, 2]));
    const restored = await CaptureJournal.open(directory);
    expect(restored.records.size).toBe(0); expect(restored.state.invalidRecords).toHaveLength(1);
    expect(await append(restored, 1)).toMatchObject({ durable: true });
    expect((await CaptureJournal.open(directory)).records.size).toBe(1);
  });
  it("detects corruption and missing final sequences without accepting another session", async () => {
    const journal = await open(); await append(journal, 1);
    await journal.checkpoint({ expectedSequences: { meeting: 2 } });
    expect(journal.snapshot("meeting").gaps).toEqual([2]);
    const record = journal.recordsDirectory.files.get("meeting-0-1.chunk"); record.bytes[record.bytes.length - 1] ^= 1;
    await expect(journal.materialize("meeting", { prefix: true })).rejects.toThrow("checksum");
    await expect(journal.append("meeting", new Uint8Array([1]), { sessionId: "other", seq: 2, generation: 0, captureTs: 1 })).rejects.toThrow("Session mismatch");
  });
  it("stops retrying quota exhaustion and retains independent generations", async () => {
    const journal = await open(); await append(journal, 1); await append(journal, 2, [2], 1);
    expect((await journal.materialize("meeting")).map((segment) => segment.generation)).toEqual([0, 1]);
    const file = await journal.recordsDirectory.getFileHandle("meeting-1-3.chunk", { create: true });
    const write = vi.spyOn(file, "createWritable").mockRejectedValue(new DOMException("Full", "QuotaExceededError"));
    await expect(append(journal, 3, [3], 1)).rejects.toMatchObject({ retryable: false });
    expect(write).toHaveBeenCalledOnce(); expect(journal.records.size).toBe(2);
  });
});
