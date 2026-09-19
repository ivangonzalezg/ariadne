import { describe, expect, it } from "vitest";
import { formatSegmentTimestamp, transcriptToTxt, transcriptToMarkdown } from "./transcript-export.js";

const segments = [
  { index: 0, startTime: 0, endTime: 4000, text: "Hola a todos", speaker: "Ana" },
  { index: 1, startTime: 75000, endTime: 80000, text: "Buenas", speaker: "Luis" },
];

describe("formatSegmentTimestamp", () => {
  it("formats milliseconds as mm:ss", () => {
    expect(formatSegmentTimestamp(0)).toBe("00:00");
    expect(formatSegmentTimestamp(75000)).toBe("01:15");
  });
});

describe("transcriptToTxt", () => {
  it("renders one bracketed line per segment", () => {
    expect(transcriptToTxt(segments)).toBe("[00:00] [Ana] Hola a todos\n[01:15] [Luis] Buenas");
  });

  it("returns an empty string for no segments", () => {
    expect(transcriptToTxt([])).toBe("");
  });

  it("collapses internal line breaks so each segment stays on one line", () => {
    const withNewlines = [{ index: 0, startTime: 0, endTime: 1000, text: "Primera línea\nsegunda línea", speaker: "Ana" }];
    expect(transcriptToTxt(withNewlines)).toBe("[00:00] [Ana] Primera línea segunda línea");
  });
});

describe("transcriptToMarkdown", () => {
  it("renders a heading and a bold speaker block per segment", () => {
    expect(transcriptToMarkdown(segments, "Daily sync")).toBe(
      "# Daily sync\n\n**Ana** _[00:00]_\nHola a todos\n\n**Luis** _[01:15]_\nBuenas\n"
    );
  });
});
