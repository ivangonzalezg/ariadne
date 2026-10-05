import { describe, it, expect } from "vitest";
import { CaptionModel } from "./caption-model.js";
const event = (id, revision, text, at = 1000) => ({ source: "dom", utteranceId: id, revision, text,
  eventSeq: revision, speaker: "Ana", firstReceivedAt: at, updatedAt: at + revision });
describe("caption identity", () => {
  it("keeps distinct phrases from the same speaker and updates an older intervention", () => {
    const model = new CaptionModel();
    model.apply(event("one", 1, "Hola")); model.apply(event("two", 1, "Hola", 2000));
    model.apply(event("one", 2, "Hola a todos")); model.apply(event("one", 1, "Viejo"));
    model.apply(event("one", 2, "Repetido"));
    expect(model.values().map(x => x.text)).toEqual(["Hola a todos", "Hola"]);
    expect(model.segments(0, 10000)[1].endTime).toBe(2001);
  });
  it("retains identity across more than fifty interventions", () => {
    const model = new CaptionModel();
    for (let i = 0; i < 100; i++) model.apply(event(String(i), 1, "Texto", i));
    model.apply(event("0", 2, "Corregido", 0));
    expect(model.values()).toHaveLength(100); expect(model.values()[0].text).toBe("Corregido");
  });
});

it("does not duplicate the own-speaker suffix", () => {
  const model = new CaptionModel();
  model.apply({ kind: "local-identity", identity: { speakerId: "a", name: "Ana (You)" } });
  model.apply({ ...event("one", 1, "Hello"), isSelf: true });
  expect(model.segments(0, 10000)[0].speaker).toBe("Ana (you)");
});
