import { describe, expect, it, vi } from "vitest";
import { AudioOutputObserver } from "./audio-output-observer.js";

function setup(options = {}) {
  class PageNode {
    constructor(context) { this.context = context; }
    connect(...args) { return connect(this, ...args); }
    disconnect(...args) { return disconnect(this, ...args); }
  }
  const connect = vi.fn((node, destination) => destination);
  const disconnect = vi.fn();
  const analysers = [];
  const bridges = [];
  const context = Object.assign(new EventTarget(), { createMediaStreamDestination() {
    const track = { stop: vi.fn() };
    const bridge = { stream: { getTracks: () => [track] }, track };
    bridges.push(bridge); return bridge;
  }, state: "running", destination: {}, createAnalyser() {
    const analyser = { fftSize: 2048, disconnect: vi.fn(), getFloatTimeDomainData(samples) { samples.fill(0.25); } };
    analysers.push(analyser); return analyser;
  } });
  const observer = new AudioOutputObserver({ now: () => 1234, ...options });
  observer.install(PageNode.prototype);
  return { observer, node: new PageNode(context), PageNode, context, connect, disconnect, analysers, bridges };
}

describe("page audio output diagnostics", () => {
  it("preserves native results and observes only the page's audible destinations", () => {
    const ownContext = { destination: {} };
    const { observer, node, context, PageNode, connect } = setup({ ignoredContext: ownContext });
    expect(node.connect(context.destination, 1, 0)).toBe(context.destination);
    expect(connect).toHaveBeenCalledWith(node, context.destination, 1, 0);
    node.connect({});
    new PageNode(ownContext).connect(ownContext.destination);
    expect(observer.getSnapshot().outputs).toHaveLength(1);
    observer.start(); observer.sample();
    expect(observer.getSnapshot().outputs[0]).toMatchObject({ nodeType: "PageNode", rms: 0.25, peak: 0.25, lastSignalAt: 1234 });
    expect(observer.getSnapshot().outputs).toHaveLength(1);
    observer.stop();
  });

  it("never hides native connect or disconnect exceptions", () => {
    const { observer, node, context, connect, disconnect } = setup();
    connect.mockImplementationOnce(() => { throw new Error("native connect"); });
    expect(() => node.connect(context.destination)).toThrow("native connect");
    expect(observer.getSnapshot().outputs).toEqual([]);
    node.connect(context.destination);
    disconnect.mockImplementationOnce(() => { throw new Error("native disconnect"); });
    expect(() => node.disconnect()).toThrow("native disconnect");
    expect(observer.getSnapshot().outputs).toHaveLength(1);
  });

  it("handles disconnect overloads without dropping unrelated outputs", () => {
    const { observer, node, context } = setup();
    node.connect(context.destination, 0); node.connect(context.destination, 1);
    node.disconnect({});
    expect(observer.getSnapshot().outputs).toHaveLength(2);
    node.disconnect(context.destination, 1);
    expect(observer.getSnapshot().outputs).toHaveLength(1);
    node.connect(context.destination, 1);
    node.disconnect(0);
    expect(observer.getSnapshot().outputs[0].key).toBe("1:1");
    node.disconnect();
    expect(observer.getSnapshot().outputs).toEqual([]);
  });

  it("cleans up only diagnostic branches and resets each session", () => {
    const { observer, node, context, disconnect, analysers } = setup();
    node.connect(context.destination);
    observer.start(); observer.sample(); observer.stop();
    expect(disconnect).toHaveBeenCalledWith(node, analysers[0], 0, 0);
    expect(disconnect).not.toHaveBeenCalledWith(node, context.destination);
    expect(analysers[0].disconnect).toHaveBeenCalledOnce();
    expect(observer.getSnapshot().outputs[0]).toMatchObject({ rms: null, lastSignalAt: 1234 });
    observer.start();
    expect(observer.getSnapshot().outputs[0].lastSignalAt).toBeNull();
    observer.sample();
    expect(analysers).toHaveLength(2);
    context.state = "suspended";
    expect(observer.getSnapshot().outputs[0].rms).toBeNull();
    context.state = "closed";
    observer.sample();
    expect(observer.getSnapshot().outputs).toEqual([]);
  });

  it("bounds the registry and isolates diagnostic failures from playback", () => {
    const { observer, node, PageNode, context, connect } = setup({ maxOutputs: 1 });
    node.connect(context.destination);
    new PageNode(context).connect(context.destination);
    expect(observer.getSnapshot().outputs).toHaveLength(1);
    observer.start();
    connect.mockImplementationOnce(() => { throw new Error("diagnostic tap"); });
    expect(() => observer.sample()).not.toThrow();
    expect(observer.getSnapshot()).toMatchObject({ errorCount: 1 });
    observer.sample();
    expect(observer.getSnapshot().outputs[0].rms).toBe(0.25);
    observer.stop();
  });
});


describe("page playback capture", () => {
  function captureSetup() {
    const mixer = { addPlaybackStream: vi.fn(), removePlaybackStream: vi.fn() };
    return { ...setup({ mixer }), mixer };
  }

  it("keeps playback capture connected when its diagnostic analyser fails", () => {
    const { observer, node, context, bridges, mixer } = captureSetup();
    node.connect(context.destination); observer.start();
    context.createAnalyser = () => { throw new Error("analysis unavailable"); };
    observer.sample(); observer.sample();
    expect(observer.getSnapshot().outputs[0]).toMatchObject({ connectedToMixer: true, rms: null });
    expect(bridges).toHaveLength(1);
    expect(bridges[0].track.stop).not.toHaveBeenCalled();
    expect(mixer.removePlaybackStream).not.toHaveBeenCalled();
    observer.stop();
  });

  it("bridges existing and late outputs immediately, deduplicating repeated connects", () => {
    const { observer, mixer, node, context, PageNode, bridges } = captureSetup();
    node.connect(context.destination);
    expect(mixer.addPlaybackStream).not.toHaveBeenCalled();
    observer.start();
    expect(mixer.addPlaybackStream).toHaveBeenCalledWith("1:0", bridges[0].stream);
    node.connect(context.destination); observer.sample();
    expect(mixer.addPlaybackStream).toHaveBeenCalledOnce();
    const late = new PageNode(context);
    late.connect(context.destination);
    expect(mixer.addPlaybackStream).toHaveBeenCalledTimes(2);
    expect(observer.getSnapshot().outputs.every((entry) => entry.connectedToMixer)).toBe(true);
    observer.stop();
  });

  it("cleans up owned bridges on disconnect, suspend, close and repeated sessions", () => {
    const { observer, mixer, node, context, bridges, disconnect } = captureSetup();
    node.connect(context.destination); observer.start();
    context.state = "suspended"; context.dispatchEvent(new Event("statechange"));
    expect(mixer.removePlaybackStream).toHaveBeenCalledWith("1:0");
    expect(bridges[0].track.stop).toHaveBeenCalledOnce();
    expect(observer.getSnapshot().outputs[0].connectedToMixer).toBe(false);
    context.state = "running"; context.dispatchEvent(new Event("statechange"));
    expect(bridges).toHaveLength(2);
    observer.start(); observer.sample(); observer.stop();
    expect(bridges).toHaveLength(3);
    expect(bridges.every((bridge) => bridge.track.stop.mock.calls.length === 1)).toBe(true);
    expect(disconnect).not.toHaveBeenCalledWith(node, context.destination);
    observer.start(); node.disconnect(context.destination);
    expect(bridges[3].track.stop).toHaveBeenCalledOnce();
    expect(observer.getSnapshot().outputs).toEqual([]);
    node.connect(context.destination);
    context.state = "closed"; context.dispatchEvent(new Event("statechange"));
    expect(observer.getSnapshot().outputs).toEqual([]);
    expect(bridges[4].track.stop).toHaveBeenCalledOnce();
    observer.stop();
  });

  it("keeps native playback intact when capture fails and retries without leaking tracks", () => {
    const { observer, mixer, node, context, bridges, disconnect } = captureSetup();
    observer.start();
    mixer.addPlaybackStream.mockImplementationOnce(() => { throw new Error("bridge failed"); });
    expect(node.connect(context.destination)).toBe(context.destination);
    expect(observer.getSnapshot()).toMatchObject({ errorCount: 1 });
    expect(observer.getSnapshot().outputs[0].connectedToMixer).toBe(false);
    expect(bridges[0].track.stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith(node, bridges[0], 0, 0);
    observer.sample();
    expect(observer.getSnapshot().outputs[0].connectedToMixer).toBe(true);
    expect(bridges).toHaveLength(2);
    observer.stop();
    expect(bridges[1].track.stop).toHaveBeenCalledOnce();
  });

  it("does not drop playback capture on silence and bounds owned bridges", () => {
    const { observer, node, context, PageNode, bridges } = setup({ maxOutputs: 1,
      mixer: { addPlaybackStream: vi.fn(), removePlaybackStream: vi.fn() } });
    node.connect(context.destination); observer.start(); observer.sample();
    context.createAnalyser = () => ({ disconnect: vi.fn(), getFloatTimeDomainData(samples) { samples.fill(0); } });
    observer.outputs.get("1:0").analyser.getFloatTimeDomainData = (samples) => samples.fill(0);
    observer.sample();
    expect(observer.getSnapshot().outputs[0]).toMatchObject({ rms: 0, connectedToMixer: true });
    new PageNode(context).connect(context.destination);
    expect(bridges[0].track.stop).toHaveBeenCalledOnce();
    expect(observer.getSnapshot().outputs).toHaveLength(1);
    observer.stop();
  });
});
