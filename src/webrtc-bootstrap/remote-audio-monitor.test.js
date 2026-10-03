import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAudioMonitor } from "./remote-audio-monitor.js";
import { MeetingAudioMixer } from "./audio-mixer.js";

function receiverTrack(id) {
  return Object.assign(new EventTarget(), {
    id, kind: "audio", readyState: "live", muted: false, enabled: true,
    clone() { return { id: `${id}-copy`, enabled: this.enabled, readyState: "live", stop: vi.fn() }; },
  });
}

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("MediaStream", class { constructor(tracks) { this.tracks = tracks; } });
  const nodes = [];
  const analysers = [];
  const context = {
    state: "running",
    createMediaStreamDestination: () => ({ stream: {} }),
    createMediaStreamSource: () => {
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      nodes.push(node);
      return node;
    },
    createAnalyser: () => {
      const analyser = { fftSize: 2048, value: 0, disconnect: vi.fn(),
        getFloatTimeDomainData(samples) { samples.fill(this.value); } };
      analysers.push(analyser);
      return analyser;
    },
  };
  const track = receiverTrack("remote");
  const mixer = new MeetingAudioMixer({ recordingType: "webrtc", audioContext: context });
  const log = vi.fn();
  const sweep = vi.fn(({ onRemoteAudioTrack }) => {
    const result = { connectionsScanned: 1, tracksFound: 1, recovered: 0, errors: [], tracks: [{ connectionId: 1, trackId: track.id, connectionState: "connected" }] };
    try { if (onRemoteAudioTrack({ connectionId: 1, track, mid: "0" }) === "added") result.recovered++; }
    catch (error) { result.errors.push({ operation: "addRemoteTrack", message: error.message }); }
    return result;
  });
  const monitor = new RemoteAudioMonitor({ mixer, sweep, log });
  return { monitor, mixer, context, nodes, analysers, track, sweep, log };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("RemoteAudioMonitor", () => {
  it("sweeps immediately and every five seconds, without duplicating sources", () => {
    const { monitor, sweep, nodes } = setup();
    monitor.start("session");
    expect(sweep).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10000);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(nodes).toHaveLength(1);
    expect(monitor.getRemoteAudioSnapshot()).toMatchObject({ sessionId: "session", sampledAt: 10000, recoveries: 1, errorCount: 0 });
    const copy = monitor.getRemoteAudioSnapshot();
    copy.lastSweep.tracks[0].trackId = "changed";
    copy.tracks[0].key = "changed";
    expect(monitor.getRemoteAudioSnapshot().lastSweep.tracks[0].trackId).toBe("remote");
    expect(monitor.getRemoteAudioSnapshot().tracks[0].key).not.toBe("changed");
    expect(() => JSON.stringify(copy)).not.toThrow();
    monitor.stop();
    vi.advanceTimersByTime(10000);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries failed source creation without breaking the session", () => {
    const { monitor, context } = setup();
    const create = context.createMediaStreamSource;
    context.createMediaStreamSource = () => { throw new Error("temporary"); };
    monitor.start("session");
    expect(monitor.getRemoteAudioSnapshot()).toMatchObject({ recoveries: 0, errorCount: 1 });
    context.createMediaStreamSource = create;
    vi.advanceTimersByTime(5000);
    expect(monitor.getRemoteAudioSnapshot()).toMatchObject({ recoveries: 1, errorCount: 1 });
    monitor.stop();
  });

  it("retains muted live tracks for over sixty seconds and observes their resumed signal", () => {
    const { monitor, track, mixer, analysers } = setup();
    monitor.start("session");
    track.muted = true;
    track.dispatchEvent(new Event("mute"));
    vi.advanceTimersByTime(65000);
    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(monitor.getRemoteAudioSnapshot().tracks[0]).toMatchObject({ muted: true, rms: 0, lastSignalAt: null });
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    analysers[0].value = 0.125;
    vi.advanceTimersByTime(500);
    expect(monitor.getRemoteAudioSnapshot().tracks[0]).toMatchObject({ muted: false, rms: 0.125, peak: 0.125, lastSignalAt: 65500 });
    monitor.stop();
  });

  it("resets session diagnostics and disconnects only the analysis branch on repeated starts", () => {
    const { monitor, nodes, analysers } = setup();
    monitor.start("first");
    analysers[0].value = 0.5;
    vi.advanceTimersByTime(500);
    monitor.start("second");
    expect(vi.getTimerCount()).toBe(2);
    expect(analysers[0].disconnect).toHaveBeenCalledOnce();
    expect(nodes[0].disconnect).toHaveBeenCalledWith(analysers[0]);
    expect(nodes[0].disconnect).not.toHaveBeenCalledWith();
    expect(monitor.getRemoteAudioSnapshot()).toMatchObject({ sessionId: "second", recoveries: 0, errorCount: 0 });
    expect(monitor.getRemoteAudioSnapshot().tracks[0].lastSignalAt).toBeNull();
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(analysers[1].disconnect).toHaveBeenCalledOnce();
  });

  it("logs state transitions and periodic summaries rather than every identical sample", () => {
    const { monitor, log, context } = setup();
    monitor.start("session");
    vi.advanceTimersByTime(30000);
    expect(log.mock.calls.filter(([event]) => event === "remote-audio-summary")).toHaveLength(2);
    expect(log.mock.calls.filter(([event]) => event === "remote-audio-state-changed")).toHaveLength(1);
    context.state = "suspended";
    expect(monitor.getRemoteAudioSnapshot().tracks[0].rms).toBeNull();
    vi.advanceTimersByTime(500);
    expect(log.mock.calls.filter(([event]) => event === "remote-audio-state-changed")).toHaveLength(2);
    monitor.stop();
  });

  it("records track event failures and allows later receiver recovery", () => {
    const { monitor, track, context } = setup();
    monitor.start("session");
    const create = context.createMediaStreamSource;
    context.createMediaStreamSource = () => { throw new Error("event source"); };
    const another = receiverTrack("another");
    expect(monitor.addRemoteTrack({ connectionId: 2, track: another })).toBe("error");
    expect(monitor.getRemoteAudioSnapshot().errorCount).toBe(1);
    context.createMediaStreamSource = create;
    expect(monitor.addRemoteTrack({ connectionId: 2, track: another })).toBe("added");
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
    expect(monitor.getRemoteAudioSnapshot().tracks.map(({ trackId }) => trackId)).toEqual(["another"]);
    monitor.stop();
  });
});

describe("recording started without remote participants", () => {
  it("recovers a receiver that becomes available after recording starts", () => {
    const { monitor, mixer, sweep, nodes } = setup();
    sweep.mockImplementationOnce(() => ({ connectionsScanned: 0, tracksFound: 0, recovered: 0, errors: [], tracks: [] }));
    monitor.start("started-alone");
    expect(monitor.getRemoteAudioSnapshot().tracks).toEqual([]);
    expect(nodes).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(mixer.activeRemoteSourceCount).toBe(1);
    expect(monitor.getRemoteAudioSnapshot()).toMatchObject({ sessionId: "started-alone", recoveries: 1 });
    expect(nodes).toHaveLength(1);
    vi.advanceTimersByTime(10000);
    expect(nodes).toHaveLength(1);
    monitor.stop();
  });

  it("connects a late track event immediately and keeps subsequent sweeps idempotent", () => {
    const { monitor, sweep, track, nodes, analysers } = setup();
    sweep.mockImplementationOnce(() => ({ connectionsScanned: 0, tracksFound: 0, recovered: 0, errors: [], tracks: [] }));
    monitor.start("started-alone");
    expect(monitor.addRemoteTrack({ connectionId: 1, track, mid: "0" })).toBe("added");
    expect(monitor.getRemoteAudioSnapshot().tracks).toHaveLength(1);
    vi.advanceTimersByTime(500);
    analysers[0].value = 0.125;
    vi.advanceTimersByTime(500);
    expect(monitor.getRemoteAudioSnapshot().tracks[0].rms).toBe(0.125);
    vi.advanceTimersByTime(5000);
    expect(nodes).toHaveLength(1);
    expect(monitor.getRemoteAudioSnapshot().recoveries).toBe(0);
    monitor.stop();
  });
});
