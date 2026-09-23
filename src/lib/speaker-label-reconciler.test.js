import { describe, expect, it } from "vitest";
import { reconcileCaptionSnapshots } from "./speaker-label-reconciler.js";

describe("reconcileCaptionSnapshots", () => {
  it("returns captions unchanged when there are no speaker labels", () => {
    const captions = [
      { speaker: "You", text: "Hola", timestampMs: 1000 },
      { speaker: "Ana", text: "Hola de vuelta", timestampMs: 2000 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels: [] })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 1000 },
      { speaker: "Ana", text: "Hola de vuelta", timestampMs: 2000 },
    ]);
  });

  it("replaces 'You' with the real name plus a (You) suffix when a label covers it", () => {
    const captions = [{ speaker: "You", text: "Hola a todos", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ivan Gonzalez", timestampMs: 950 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ivan Gonzalez (You)", text: "Hola a todos", timestampMs: 1000 },
    ]);
  });

  it("replaces a non-'You' speaker with the plain real name, no (You) suffix", () => {
    const captions = [{ speaker: "Beto", text: "Hola", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ana", timestampMs: 950 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ana", text: "Hola", timestampMs: 1000 },
    ]);
  });

  it("falls back to the original speaker when no label window covers the caption", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ivan Gonzalez", timestampMs: 5000 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 1000 },
    ]);
  });

  it("collapses consecutive same-speaker labels within maxLabelDistanceMs", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 1080 }];
    const speakerLabels = [
      { speakerName: "Ivan Gonzalez", timestampMs: 900 },
      { speakerName: "Ivan Gonzalez", timestampMs: 990 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ivan Gonzalez (You)", text: "Hola", timestampMs: 1080 },
    ]);
  });

  it("discards a label window shorter than minLabelDurationMs as noise", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 1005 }];
    const speakerLabels = [
      { speakerName: "Ivan Gonzalez", timestampMs: 1000 },
      { speakerName: null, timestampMs: 1010 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 1005 },
    ]);
  });

  it("does not let two adjacent speakers' tolerance windows steal a caption that falls inside the newer one", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 2050 }];
    const speakerLabels = [
      { speakerName: "Ana", timestampMs: 1000 },
      { speakerName: "Beto", timestampMs: 2000 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Beto (You)", text: "Hola", timestampMs: 2050 },
    ]);
  });

  it("a null speakerName label closes the previous window (silence) without starting a new one", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 3000 }];
    const speakerLabels = [
      { speakerName: "Ivan Gonzalez", timestampMs: 1000 },
      { speakerName: null, timestampMs: 2000 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 3000 },
    ]);
  });
});
