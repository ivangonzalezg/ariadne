import { describe, expect, it } from "vitest";
import { CaptionParser } from "./caption-parser.js";

describe("CaptionParser", () => {
  it("emits nothing while the same speaker keeps updating text", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.onSnapshot({ speaker: "Ana", text: "Hola a todos", timestampMs: 400 });
    expect(parser.finishedSegments).toEqual([]);
  });

  it("finalizes the previous speaker's segment when the speaker changes", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.onSnapshot({ speaker: "Ana", text: "Hola a todos", timestampMs: 400 });
    parser.onSnapshot({ speaker: "Beto", text: "Hola Ana", timestampMs: 900 });
    expect(parser.finishedSegments).toEqual([
      { speaker: "Ana", text: "Hola a todos", startMs: 100, endMs: 400 },
    ]);
  });

  it("updates a segment when consecutive snapshots have the same captionId", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "unknown", text: "Hola", timestampMs: 100, captionId: "caption-1" });
    parser.onSnapshot({ speaker: "unknown", text: "Hola a todos", timestampMs: 400, captionId: "caption-1" });
    parser.finalizeCurrent(500);
    expect(parser.finishedSegments).toEqual([
      { speaker: "unknown", text: "Hola a todos", startMs: 100, endMs: 500 },
    ]);
  });

  it("finalizes a captionId segment when the next captionId differs", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "unknown", text: "Hola", timestampMs: 100, captionId: "caption-1" });
    parser.onSnapshot({ speaker: "unknown", text: "Otra intervención", timestampMs: 400, captionId: "caption-2" });
    expect(parser.finishedSegments).toEqual([
      { speaker: "unknown", text: "Hola", startMs: 100, endMs: 100 },
    ]);
  });

  it("separates snapshots when switching between captionId and legacy speaker grouping", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "unknown", text: "WebRTC", timestampMs: 100, captionId: "caption-1" });
    parser.onSnapshot({ speaker: "unknown", text: "DOM", timestampMs: 400 });
    expect(parser.finishedSegments).toEqual([
      { speaker: "unknown", text: "WebRTC", startMs: 100, endMs: 100 },
    ]);
  });

  it("ignores a snapshot identical to the current one (no-op)", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 150 });
    parser.finalizeCurrent(200);
    expect(parser.finishedSegments).toEqual([
      { speaker: "Ana", text: "Hola", startMs: 100, endMs: 200 },
    ]);
  });

  it("uses 'unknown' when no speaker is available", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: null, text: "algo", timestampMs: 100 });
    parser.finalizeCurrent(200);
    expect(parser.finishedSegments).toEqual([
      { speaker: "unknown", text: "algo", startMs: 100, endMs: 200 },
    ]);
  });

  it("finalizeCurrent closes an in-progress segment", () => {
    const parser = new CaptionParser();
    parser.onSnapshot({ speaker: "Ana", text: "Hola", timestampMs: 100 });
    parser.finalizeCurrent(1000);
    expect(parser.finishedSegments).toEqual([
      { speaker: "Ana", text: "Hola", startMs: 100, endMs: 1000 },
    ]);
  });
});
