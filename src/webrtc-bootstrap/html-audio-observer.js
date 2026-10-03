// Observe stream-backed audio elements without changing their playback.
export class HtmlAudioObserver {
  constructor({ mixer, document = globalThis.document, log = () => {} }) {
    this.mixer = mixer;
    this.document = document;
    this.log = log;
    this.elements = new Map();
    this.streams = new Map();
    this.active = false;
    this.errors = 0;
  }

  install(prototype = globalThis.HTMLMediaElement?.prototype) {
    if (this.original || !prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "srcObject");
    if (!descriptor?.set || !descriptor.get) return;
    this.original = descriptor;
    const observer = this;
    Object.defineProperty(prototype, "srcObject", { ...descriptor,
      set(value) {
        descriptor.set.call(this, value);
        try { if (this.tagName === "AUDIO") observer.sync(this); }
        catch (error) { observer.error(error); }
      },
    });
  }

  error(error) {
    this.errors++;
    this.log("html-capture-error", { message: String(error.message ?? error) });
  }

  sync(element) {
    if (!this.active) return;
    const old = this.elements.get(element);
    const stream = element.srcObject;
    const tracks = stream?.getAudioTracks?.() ?? [];
    const usable = element.isConnected && tracks.some((track) => track.readyState === "live");
    const signature = tracks.filter((track) => track.readyState === "live").map((track) => track.id).sort().join(":");
    const shared = this.streams.get(stream?.id);
    if (shared && shared.signature !== signature) {
      for (const owner of [...shared.owners]) this.remove(owner);
    }
    if (old && (!usable || old.stream !== stream || old.signature !== signature)) this.remove(element);
    if (!usable || this.elements.has(element)) return;
    try {
      let entry = this.streams.get(stream.id);
      if (!entry) {
        this.mixer.addHtmlStream(stream);
        const refresh = () => this.scan();
        const listeners = [[stream, "addtrack"], [stream, "removetrack"], ...tracks.map((track) => [track, "ended"])];
        for (const [target, type] of listeners) target.addEventListener?.(type, refresh);
        entry = { stream, signature, owners: new Set(), listeners, refresh };
        this.streams.set(stream.id, entry);
      }
      entry.owners.add(element);
      this.elements.set(element, { stream, signature });
    } catch (error) { this.error(error); }
  }

  remove(element) {
    const owned = this.elements.get(element);
    if (!owned) return;
    this.elements.delete(element);
    const entry = this.streams.get(owned.stream.id);
    entry.owners.delete(element);
    if (entry.owners.size) return;
    this.mixer.removeHtmlStream(owned.stream.id);
    for (const [target, type] of entry.listeners) target.removeEventListener?.(type, entry.refresh);
    this.streams.delete(owned.stream.id);
  }

  scan() {
    if (!this.active) return;
    for (const element of [...this.elements.keys()]) this.sync(element);
    for (const element of this.document.querySelectorAll("audio")) this.sync(element);
  }

  start() {
    this.stop();
    this.active = true;
    this.errors = 0;
    this.scan();
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(this.document.documentElement, { childList: true, subtree: true });
  }

  stop() {
    this.active = false;
    this.observer?.disconnect();
    this.observer = null;
    for (const element of [...this.elements.keys()]) this.remove(element);
  }

  getSnapshot() {
    return { active: this.active, errorCount: this.errors, streams: [...this.streams.values()].map(({ stream, owners }) => ({
      streamId: stream.id, references: owners.size, trackIds: stream.getAudioTracks().map((track) => track.id),
      connectedToMixer: this.mixer.htmlSources.has(stream.id) || Boolean(this.mixer.remoteSources?.get(`stream:${stream.id}`)?.connectedToMixer),
    })) };
  }
}
