import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureHealth } from "./capture-health.js";
function setup() {
  vi.useFakeTimers();
  const mixer = { audioContext: { state: "running" }, resume: vi.fn(), htmlSources: new Map(), playbackSources: new Map(), remoteSources: new Map(), destination: {}, reconnectRemoteStream: vi.fn().mockReturnValue(true) };
  const session = { meetingRecorder: { state: "recording" }, committedChunks: 1 };
  const scan = vi.fn(), restart = vi.fn().mockResolvedValue(true), log = vi.fn();
  const health = new CaptureHealth({ getSession: () => session, getMixer: () => mixer, scan, restart, log });
  return { health, mixer, session, scan, restart, log };
}
afterEach(() => vi.useRealTimers());
describe("capture recovery", () => {
  it("checks after 5s, transitions from 10s to 30s, coalesces events and releases timers", async () => {
    const { health, scan } = setup(); health.start();
    await vi.advanceTimersByTimeAsync(5000); expect(scan).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(115000); expect(health.checks).toBe(12);
    const count = scan.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29999); expect(scan).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); expect(scan).toHaveBeenCalledTimes(count + 1);
    health.schedule(); health.schedule();
    await vi.advanceTimersByTimeAsync(3000); expect(scan).toHaveBeenCalledTimes(count + 2);
    health.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("resumes suspended contexts, restarts persistent suspension and dead recorders", async () => {
    const { health, mixer, restart, session } = setup(); health.start();
    mixer.audioContext.state = "suspended";
    await health.check(false); await health.check(false);
    expect(mixer.resume).toHaveBeenCalledTimes(2);
    await health.check(false); expect(restart).toHaveBeenCalledWith("context-persistently-suspended");
    mixer.audioContext.state = "closed"; await health.check(false); expect(restart).toHaveBeenCalledWith("context-closed");
    mixer.audioContext.state = "running"; session.meetingRecorder.state = "inactive";
    await health.check(false); expect(restart).toHaveBeenCalledWith("recorder-not-recording");
    health.stop();
  });
  it("bounds chunk and missing-persistence recovery without treating mute as a failure", async () => {
    const { health, scan, restart, session } = setup(); health.start();
    for (let i = 0; i < 100; i++) health.chunk(100);
    expect(scan).toHaveBeenCalledTimes(3);
    health.chunk(1000); for (let i = 0; i < 5; i++) health.chunk(100);
    expect(scan).toHaveBeenCalledTimes(4);
    session.committedChunks = 0; await health.checkStorage(); await health.checkStorage(); await health.checkStorage();
    expect(restart).toHaveBeenCalledTimes(2); health.stop();
  });
  it("reconnects muted sources only with announced mic-on metadata and rate limits each stream", () => {
    const { health, mixer } = setup();
    const entry = { track: { muted: true }, connectedToMixer: true, sourceNode: { connect: vi.fn(), disconnect: vi.fn() } };
    mixer.remoteSources.set("remote", entry); health.start();
    health.inspectMutedSources(); health.inspectMutedSources(); expect(mixer.reconnectRemoteStream).not.toHaveBeenCalled();
    health.getRemoteMicState = () => true;
    health.inspectMutedSources(); health.inspectMutedSources(); health.inspectMutedSources();
    expect(mixer.reconnectRemoteStream).toHaveBeenCalledOnce(); health.stop();
  });
});
