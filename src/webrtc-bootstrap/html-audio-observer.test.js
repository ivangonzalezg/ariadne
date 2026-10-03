import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlAudioObserver } from "./html-audio-observer.js";
const stream = (id, tracks = [Object.assign(new EventTarget(), { id: "track", readyState: "live" })]) => Object.assign(new EventTarget(), { id, getAudioTracks: () => tracks });
function setup() {
  const mixer = { htmlSources: new Map(), addHtmlStream: vi.fn(function(s) { this.htmlSources.set(s.id, s); }), removeHtmlStream: vi.fn(function(id) { this.htmlSources.delete(id); }) };
  const observer = new HtmlAudioObserver({ mixer });
  return { mixer, observer };
}
afterEach(() => document.body.replaceChildren());
describe("stream-backed HTML capture", () => {
  it("captures existing and late audio elements, retaining a shared stream until its final owner leaves", async () => {
    const { mixer, observer } = setup();
    const shared = stream("shared");
    const first = document.createElement("audio"), second = document.createElement("audio");
    first.srcObject = shared; second.srcObject = shared;
    document.body.append(first, second); observer.start();
    expect(mixer.addHtmlStream).toHaveBeenCalledOnce();
    first.remove(); await Promise.resolve();
    expect(mixer.removeHtmlStream).not.toHaveBeenCalled();
    const late = document.createElement("audio"); late.srcObject = stream("late");
    const parent = document.createElement("div"); parent.append(late); document.body.append(parent);
    await Promise.resolve(); expect(mixer.htmlSources.size).toBe(2);
    second.remove(); await Promise.resolve();
    expect(mixer.removeHtmlStream).toHaveBeenCalledWith("shared");
    observer.stop(); expect(mixer.htmlSources.size).toBe(0);
  });
  it("handles null, replacement, track changes, failed creation and repeated sessions", () => {
    const { mixer, observer } = setup();
    const audio = document.createElement("audio"); document.body.append(audio);
    audio.srcObject = stream("one"); observer.start();
    audio.srcObject = null; observer.scan(); expect(mixer.htmlSources.size).toBe(0);
    mixer.addHtmlStream.mockImplementationOnce(() => { throw new Error("temporary"); });
    const next = stream("two"); audio.srcObject = next; observer.scan();
    expect(observer.getSnapshot().errorCount).toBe(1);
    observer.scan(); expect(mixer.htmlSources.size).toBe(1);
    next.getAudioTracks()[0].readyState = "ended";
    next.getAudioTracks()[0].dispatchEvent(new Event("ended"));
    expect(mixer.htmlSources.size).toBe(0);
    audio.srcObject = stream("three"); observer.scan(); observer.start();
    expect(mixer.htmlSources.size).toBe(1);
    observer.stop(); expect(mixer.htmlSources.size).toBe(0);
  });
  it("preserves native setter errors and performs immediate updates after accepted assignments", () => {
    const { observer, mixer } = setup();
    class Media { constructor() { this.tagName = "AUDIO"; this.isConnected = true; } }
    Object.defineProperty(Media.prototype, "srcObject", { configurable: true,
      get() { return this.value; }, set(value) { if (value === "invalid") throw new Error("native"); this.value = value; } });
    observer.install(Media.prototype); observer.active = true;
    const element = new Media(); element.srcObject = stream("one");
    expect(mixer.htmlSources.size).toBe(1);
    expect(() => { element.srcObject = "invalid"; }).toThrow("native");
    expect(mixer.htmlSources.size).toBe(1);
    element.srcObject = stream("two"); expect(mixer.htmlSources.has("one")).toBe(false);
    element.srcObject = null; expect(mixer.htmlSources.size).toBe(0);
    observer.stop();
  });
  it("rebuilds a shared stream source when its live tracks change", () => {
    const { mixer, observer } = setup();
    const tracks = [Object.assign(new EventTarget(), { id: "old", readyState: "live" })];
    const shared = stream("shared", tracks);
    const first = document.createElement("audio"), second = document.createElement("audio");
    first.srcObject = shared; second.srcObject = shared; document.body.append(first, second); observer.start();
    tracks.splice(0, 1, Object.assign(new EventTarget(), { id: "new", readyState: "live" }));
    shared.dispatchEvent(new Event("addtrack"));
    expect(mixer.addHtmlStream).toHaveBeenCalledTimes(2);
    expect(observer.getSnapshot().streams[0]).toMatchObject({ references: 2, trackIds: ["new"] });
    observer.stop();
  });

});
