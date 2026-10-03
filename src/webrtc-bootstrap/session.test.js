import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWorldSession } from "./session.js";
class Recorder {
  static instances = [];
  constructor(stream) { this.stream = stream; this.state = "inactive"; Recorder.instances.push(this); }
  start(slice) { this.slice = slice; this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable({ data: { size: 1, arrayBuffer: async () => new Uint8Array([7]).buffer } }); queueMicrotask(() => this.onstop()); }
}
const mixer = () => ({ stream: { getAudioTracks: () => [{ id: "mixed" }] }, setMicMuted: vi.fn() });
const create = (postToIsolated = vi.fn()) => new MainWorldSession({ sessionId: "session", mixer: mixer(), postToIsolated, initialMicMuted: true });
beforeEach(() => { Recorder.instances = []; vi.stubGlobal("MediaRecorder", Recorder); vi.stubGlobal("MediaStream", class { constructor(tracks) { this.tracks = tracks; } }); });
afterEach(() => vi.unstubAllGlobals());
describe("recorder generations", () => {
  it("flushes final data and pending persistence before announcing completion", async () => {
    let release; const saved = new Promise((resolve) => { release = resolve; });
    const messages = [], session = create(async (msg) => { messages.push(msg); if (msg.type === "asterion:chunk") await saved; });
    session.start(); expect(session.meetingRecorder.slice).toBe(2000);
    const stopped = session.stop(); await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages.map((msg) => msg.type)).toEqual(["asterion:chunk"]);
    release(); await stopped;
    expect(messages[0]).toMatchObject({ generation: 0, seq: 1, sessionId: "session", captureTs: expect.any(Number) });
    expect(messages[1].type).toBe("asterion:session-ended");
  });
  it("coalesces restarts, preserves video tracks and increments generation without resetting sequence", async () => {
    const post = vi.fn(), session = create(post); session.start();
    const screen = { stop: vi.fn() }, display = { getVideoTracks: () => [screen], getTracks: () => [screen] };
    session.enableVideo(display);
    const factory = vi.fn(async () => mixer()), first = session.restart(factory);
    expect(session.restart(factory)).toBe(first); await first;
    expect(factory).toHaveBeenCalledOnce(); expect(screen.stop).not.toHaveBeenCalled();
    expect(session.generation).toBe(1); expect(Recorder.instances).toHaveLength(4);
    await session.stop();
    expect(post.mock.calls.filter(([msg]) => msg.type === "asterion:chunk").map(([msg]) => [msg.stream, msg.generation, msg.seq])).toEqual([["meeting", 0, 1], ["video", 0, 1], ["meeting", 1, 2], ["video", 1, 2]]);
    expect(screen.stop).toHaveBeenCalledOnce();
  });
  it("cancels continuation when stopped during asynchronous reconstruction", async () => {
    let resolve; const gate = new Promise((done) => { resolve = done; });
    const session = create(); session.start();
    const restarted = session.restart(() => gate);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const stopped = session.stop(); resolve(mixer());
    expect(await restarted).toBe(false); await stopped;
    expect(Recorder.instances).toHaveLength(1);
  });
  it("deduplicates persistence confirmations and rejects another session", () => {
    const session = create(); session.seq.meeting = 1;
    const ack = { sessionId: "session", stream: "meeting", generation: 0, seq: 1 };
    session.confirmChunk(ack); session.confirmChunk(ack); session.confirmChunk({ ...ack, sessionId: "other" });
    expect(session.committedChunks).toBe(1);
  });
});

it("waits for asynchronous final data when a recorder error already made it inactive", async () => {
  const messages = [], session = create((message) => messages.push(message)); session.start();
  session.meetingRecorder.state = "inactive";
  const restarted = session.restart(async () => mixer());
  await Promise.resolve(); expect(messages).toEqual([]);
  session.meetingRecorder.ondataavailable({ data: { size: 1, arrayBuffer: async () => new Uint8Array([9]).buffer } });
  session.meetingRecorder.onstop(); await restarted;
  expect(messages[0]).toMatchObject({ type: "asterion:chunk", generation: 0, seq: 1 });
  await session.stop();
});
