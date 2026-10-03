import { measureAudioSamples } from "./audio-levels.js";

// Preserve page playback and bridge its final outputs through owned streams.
// Native connect/disconnect results and the page's tracks remain untouched.
export class AudioOutputObserver {
  constructor({ ignoredContext, mixer = null, log = () => {}, now = () => Date.now(), maxOutputs = Infinity } = {}) {
    this.ignoredContext = ignoredContext;
    this.now = now;
    this.maxOutputs = maxOutputs;
    this.mixer = mixer;
    this.log = log;
    this.outputs = new Map();
    this.nodeIds = new WeakMap();
    this.nextId = 1;
    this.active = false;
    this.errorCount = 0;
  }

  install(prototype = globalThis.AudioNode?.prototype) {
    if (!prototype || this.connect) return;
    this.connect = prototype.connect;
    this.disconnect = prototype.disconnect;
    const observer = this;
    prototype.connect = function (...args) {
      const result = observer.connect.apply(this, args);
      try {
        if (this.context !== observer.ignoredContext && args[0] === this.context.destination) {
          observer._observe(this, args[1] ?? 0);
        }
      } catch { observer.errorCount++; }
      return result;
    };
    prototype.disconnect = function (...args) {
      const result = observer.disconnect.apply(this, args);
      try { observer._forget(this, args); } catch { observer.errorCount++; }
      return result;
    };
  }

  _observe(node, output) {
    if (!this.nodeIds.has(node)) this.nodeIds.set(node, this.nextId++);
    const key = `${this.nodeIds.get(node)}:${output}`;
    if (this.outputs.has(key)) return;
    if (this.outputs.size >= this.maxOutputs) this._remove(this.outputs.keys().next().value);
    const entry = {
      key,
      node: new WeakRef(node), type: node.constructor.name, output,
      bridge: null,
      analyser: null, samples: null, rms: null, peak: null, lastSignalAt: null,
    };
    entry.onStateChange = () => this.sample();
    node.context.addEventListener?.("statechange", entry.onStateChange);
    this.outputs.set(key, entry);
    if (this.active) this._capture(entry);
  }

  _forget(node, args) {
    const id = this.nodeIds.get(node);
    if (!id) return;
    if (args.length && typeof args[0] !== "number" && args[0] !== node.context.destination) return;
    const output = typeof args[0] === "number" ? args[0] : args[1];
    for (const [key, entry] of this.outputs) {
      if (key.startsWith(`${id}:`) && (output === undefined || entry.output === output)) this._remove(key);
    }
  }

  _detach(entry) {
    this._detachCapture(entry);
    this._detachAnalysis(entry);
  }

  _detachAnalysis(entry) {
    if (entry.analyser) {
      const node = entry.node.deref();
      try { if (node) this.disconnect.call(node, entry.analyser, entry.output, 0); } catch { /* already disconnected */ }
      entry.analyser.disconnect();
    }
    entry.analyser = null;
    entry.samples = null;
    entry.rms = null;
    entry.peak = null;
  }

  _remove(key) {
    const entry = this.outputs.get(key);
    entry.node.deref()?.context.removeEventListener?.("statechange", entry.onStateChange);
    this._detach(entry);
    this.outputs.delete(key);
  }

  _capture(entry) {
    if (this.mixer?.recordingType && this.mixer.recordingType !== "hybrid") return;
    const node = entry.node.deref();
    if (!this.active || !this.mixer || entry.bridge || node?.context.state !== "running") return;
    let destination;
    try {
      destination = node.context.createMediaStreamDestination();
      this.connect.call(node, destination, entry.output, 0);
      this.mixer.addPlaybackStream(entry.key, destination.stream);
      entry.bridge = destination;
      this.log("playback-source-connected", { key: entry.key, nodeType: entry.type });
    } catch (error) {
      if (destination) {
        try { this.disconnect.call(node, destination, entry.output, 0); } catch { /* failed connection */ }
        destination.stream.getTracks().forEach((track) => track.stop());
      }
      this.errorCount++;
      this.log("playback-capture-error", { key: entry.key, message: String(error.message ?? error) });
    }
  }

  _detachCapture(entry) {
    if (!entry.bridge) return;
    this.mixer.removePlaybackStream(entry.key);
    const node = entry.node.deref();
    try { if (node) this.disconnect.call(node, entry.bridge, entry.output, 0); } catch { /* already disconnected */ }
    entry.bridge.stream.getTracks().forEach((track) => track.stop());
    entry.bridge = null;
  }

  start() {
    this.stop();
    this.active = true;
    this.errorCount = 0;
    for (const entry of this.outputs.values()) {
      entry.lastSignalAt = null;
      this._capture(entry);
    }
  }

  stop() {
    this.active = false;
    for (const entry of this.outputs.values()) this._detach(entry);
  }

  sample() {
    for (const [key, entry] of this.outputs) {
      const node = entry.node.deref();
      entry.rms = null;
      entry.peak = null;
      if (!node || node.context.state === "closed") { this._remove(key); continue; }
      if (node.context.state !== "running") this._detachCapture(entry);
      if (!this.active || node.context.state !== "running") continue;
      this._capture(entry);
      try {
        if (!entry.analyser) {
          const analyser = node.context.createAnalyser();
          analyser.fftSize = 2048;
          try { this.connect.call(node, analyser, entry.output, 0); }
          catch (error) { analyser.disconnect(); throw error; }
          entry.analyser = analyser;
          entry.samples = new Float32Array(analyser.fftSize);
        }
        entry.analyser.getFloatTimeDomainData(entry.samples);
        Object.assign(entry, measureAudioSamples(entry.samples));
        if (entry.rms > 0.001) entry.lastSignalAt = this.now();
      } catch { this.errorCount++; this._detachAnalysis(entry); }
    }
  }

  getSnapshot() {
    return { active: this.active, errorCount: this.errorCount, outputs: [...this.outputs].map(([key, entry]) => {
      const state = entry.node.deref()?.context.state ?? "unavailable";
      const measured = this.active && state === "running";
      return { key, nodeType: entry.type, contextState: state,
        connectedToMixer: Boolean(entry.bridge),
        rms: measured ? entry.rms : null, peak: measured ? entry.peak : null, lastSignalAt: entry.lastSignalAt };
    }) };
  }
}
