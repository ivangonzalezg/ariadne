import { describe, expect, it, vi } from "vitest";
import { MemoryDirectoryHandle } from "../../tests/helpers/memory-opfs.js";
import { CAPTURE_STATE_FILE, readJson, writeFile } from "./capture-journal.js";
import { cleanMeeting } from "./meeting-cleanup.js";

async function completeMeeting() {
  const directory = new MemoryDirectoryHandle("meeting");
  const done = stream => ({ stream, state: "succeeded", published: true });
  const state = {
    sessionId: "session", recordingStatus: "complete", transcriptStatus: "complete",
    conversions: [done("meeting"), done("video")],
    recoveryTasks: [done("transcript"), done("publication")],
    captureSegments: [{ stream: "video", generation: 0 }], captionSnapshots: [{ text: "words" }],
  };
  await writeFile(directory, CAPTURE_STATE_FILE, JSON.stringify(state));
  await writeFile(directory, "manifest.json", JSON.stringify({
    sessionId: "session", hasVideo: true, hasTranscript: true, captureSegments: state.captureSegments,
  }));
  await writeFile(directory, "transcripcion.json", JSON.stringify([{ text: "words" }]));
  for (const name of ["audio-reunion.mp3", "video-reunion.mp4", "audio-reunion.webm",
    "video-reunion.webm", "video-segment-0.webm", "user-notes.txt"]) {
    await writeFile(directory, name, new Uint8Array([1]));
  }
  const chunks = await directory.getDirectoryHandle("capture-records", { create: true });
  await writeFile(chunks, "video-0-1.chunk", new Uint8Array([1]));
  await writeFile(chunks, "unrecognized.txt", "keep");
  const captions = await directory.getDirectoryHandle("caption-records", { create: true });
  await writeFile(captions, "1.json", "{}");
  return { directory, state, chunks };
}

describe("meeting cleanup", () => {
  it("removes intermediates only after invalidation and records completion", async () => {
    const { directory, state, chunks } = await completeMeeting();
    expect(await cleanMeeting(directory, state, async () => {
      expect(chunks.files.has("video-0-1.chunk")).toBe(true);
      return true;
    })).toBe("complete");
    expect([...directory.files.keys()].sort()).toEqual([
      "audio-reunion.mp3", CAPTURE_STATE_FILE, "manifest.json", "transcripcion.json", "user-notes.txt", "video-reunion.mp4",
    ].sort());
    expect([...chunks.files.keys()]).toEqual(["unrecognized.txt"]);
    expect(directory.directories.has("caption-records")).toBe(false);
    const saved = await readJson(directory, CAPTURE_STATE_FILE);
    expect(saved.cleanup).toEqual({ version: 1, status: "complete" });
    expect(saved.captureSegments).toBeUndefined();
    expect(saved.captionSnapshots).toBeUndefined();
  });

  it.each([
    ["a missing MP4", async directory => directory.removeEntry("video-reunion.mp4")],
    ["an incomplete recording", async (_, state) => { state.recordingStatus = "incomplete"; }],
    ["a failed conversion", async (_, state) => { state.conversions[0].state = "failed"; }],
    ["an invalid transcript", async directory => writeFile(directory, "transcripcion.json", "{}")],
  ])("retains sources with %s", async (_, change) => {
    const { directory, state, chunks } = await completeMeeting();
    await change(directory, state);
    const invalidate = vi.fn();
    expect(await cleanMeeting(directory, state, invalidate)).toBe("retained");
    expect(invalidate).not.toHaveBeenCalled();
    expect(chunks.files.has("video-0-1.chunk")).toBe(true);
    expect(directory.directories.has("caption-records")).toBe(true);
  });

  it("revalidates outputs when resuming an interrupted cleanup", async () => {
    const { directory, state } = await completeMeeting();
    const remove = directory.removeEntry.bind(directory);
    directory.removeEntry = async (name, options) => {
      if (name === "video-segment-0.webm") throw new Error("Interrupted");
      return remove(name, options);
    };
    await expect(cleanMeeting(directory, state, async () => true)).rejects.toThrow("Interrupted");
    const pending = await readJson(directory, CAPTURE_STATE_FILE);
    expect(pending.cleanup.status).toBe("pending");
    directory.removeEntry = remove;
    const video = directory.files.get("video-reunion.mp4");
    await remove("video-reunion.mp4");
    expect(await cleanMeeting(directory, pending, async () => true)).toBe("pending");
    expect(directory.files.has("video-segment-0.webm")).toBe(true);
    directory.files.set("video-reunion.mp4", video);
    expect(await cleanMeeting(directory, pending, async () => true)).toBe("complete");
    expect(directory.files.has("video-segment-0.webm")).toBe(false);
  });
});
