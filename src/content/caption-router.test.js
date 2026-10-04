import { describe, expect, it, vi } from "vitest";
import { CaptionRouter } from "./caption-router.js";
const event = (source, id = "one", text = "Hola", revision = 1, at = 1) => ({ source, utteranceId: id, speaker: "Ana", text, revision, firstReceivedAt: at, updatedAt: at });
describe("caption source arbitration", () => {
  it("keeps WebRTC observational in shadow and rejects obsolete sessions", () => {
    const emit = vi.fn(), log = vi.fn(), router = new CaptionRouter({ sessionId: "s", mode: "shadow", emit, log });
    router.receive(event("dom")); router.receive(event("webrtc")); router.receive({ ...event("dom", "two"), sessionId: "old" });
    expect(emit).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledWith("caption-shadow-comparison", expect.objectContaining({ matched: true }));
  });
  it("preserves owner identity when switching to RTC and back to DOM", () => {
    const emit = vi.fn(), router = new CaptionRouter({ sessionId: "s", mode: "hybrid", emit });
    router.receive(event("dom")); router.setRtcStatus({ sessionId: "s", usable: true });
    router.receive(event("webrtc")); router.receive(event("webrtc", "one", "Hola a todos", 2));
    router.receive(event("dom", "one", "Hola a todos", 2));
    router.setRtcStatus({ sessionId: "s", usable: false });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toMatchObject({ source: "dom", utteranceId: "one", revision: 2, text: "Hola a todos" });
  });
  it("keeps ambiguous repeated phrases distinct and reports the ambiguity", () => {
    const emit = vi.fn(), log = vi.fn(), router = new CaptionRouter({ sessionId: "s", mode: "hybrid", emit, log });
    router.receive(event("dom", "one")); router.receive(event("dom", "two"));
    router.setRtcStatus({ sessionId: "s", usable: true }); router.receive(event("webrtc"));
    expect(emit).toHaveBeenCalledTimes(3); expect(log).toHaveBeenCalledWith("caption-ambiguous-match", { count: 2 });
  });
  it("captures buffered DOM phrases on channel failure and keeps late revisions attached", () => {
    const emit = vi.fn(), router = new CaptionRouter({ sessionId: "s", mode: "hybrid", emit });
    router.setRtcStatus({ sessionId: "s", usable: true }); router.receive(event("webrtc"));
    router.receive(event("dom", "two", "Segunda", 1, 10000));
    router.setRtcStatus({ sessionId: "s", usable: false });
    expect(emit.mock.calls.map(([e]) => e.text)).toEqual(["Hola", "Segunda"]);
    router.receive(event("dom", "two", "Segunda revisada", 2, 10000));
    expect(emit.mock.calls.at(-1)[0]).toMatchObject({ utteranceId: "two", revision: 2 });
  });
});

it("merges initially different partial text when a unique exact match later converges", async () => {
  const { CaptionModel } = await import("../lib/caption-model.js");
  const model = new CaptionModel(); let seq = 0;
  const router = new CaptionRouter({ sessionId: "s", mode: "hybrid", emit: e => model.apply({ ...e, eventSeq: ++seq }) });
  router.receive(event("dom", "dom-one", "Hola"));
  router.setRtcStatus({ sessionId: "s", usable: true });
  router.receive(event("webrtc", "rtc-one", "Hola a todos"));
  expect(model.values()).toHaveLength(2);
  router.setRtcStatus({ sessionId: "s", usable: false });
  router.receive(event("dom", "dom-one", "Hola a todos", 2));
  expect(model.values()).toHaveLength(1);
  expect(model.values()[0]).toMatchObject({ source: "dom", utteranceId: "dom-one", text: "Hola a todos" });
});

it("does not merge a second identical DOM intervention into an existing cross-source alias", async () => {
  const { CaptionModel } = await import("../lib/caption-model.js"); const model = new CaptionModel(); let seq = 0;
  const router = new CaptionRouter({ sessionId: "s", mode: "hybrid", emit: e => model.apply({ ...e, eventSeq: ++seq }) });
  router.receive(event("dom", "first")); router.setRtcStatus({ sessionId: "s", usable: true });
  router.receive(event("webrtc", "rtc-first")); router.setRtcStatus({ sessionId: "s", usable: false });
  router.receive(event("dom", "second")); router.setRtcStatus({ sessionId: "s", usable: true });
  router.receive(event("webrtc", "rtc-first", "Hola", 2));
  expect(model.values()).toHaveLength(2);
});
