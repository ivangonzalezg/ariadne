import { describe, expect, it } from "vitest";
import { reconcileCaptionSnapshots } from "./speaker-label-reconciler.js";

describe("reconcileCaptionSnapshots", () => {
  it("returns captions unchanged, including extra fields, when there are no speaker labels", () => {
    const captions = [
      { speaker: "You", text: "Hola", timestampMs: 1000, captionId: "caption-1", source: "webrtc" },
      { speaker: "Ana", text: "Hola de vuelta", timestampMs: 2000 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels: [] })).toEqual([
      { speaker: "You", text: "Hola", timestampMs: 1000, captionId: "caption-1", source: "webrtc" },
      { speaker: "Ana", text: "Hola de vuelta", timestampMs: 2000 },
    ]);
  });

  it("preserves extra fields when reconciling a 'You' caption", () => {
    const captions = [{ speaker: "You", text: "Hola", timestampMs: 1000, captionId: "caption-1", source: "webrtc" }];
    const speakerLabels = [{ speakerName: "Ivan Gonzalez", timestampMs: 950 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      {
        speaker: "Ivan Gonzalez (You)",
        text: "Hola",
        timestampMs: 1000,
        captionId: "caption-1",
        source: "webrtc",
      },
    ]);
  });

  it("replaces 'You' with the real name plus a (You) suffix when a label covers it", () => {
    const captions = [{ speaker: "You", text: "Hola a todos", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ivan Gonzalez", timestampMs: 950 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ivan Gonzalez (You)", text: "Hola a todos", timestampMs: 1000 },
    ]);
  });

  it("never overwrites a caption Meet already attributed to a real (non-'You') speaker, even if a window overlaps it", () => {
    // Corregido tras verificación manual contra una reunión real (Tarea 8):
    // el panel de captions de Meet ya es la fuente de verdad para cualquier
    // hablante que no sea uno mismo - las ventanas de indicador solo sirven
    // para resolver "You", nunca para "corregir" un nombre que Meet ya dio bien.
    const captions = [{ speaker: "Beto", text: "Hola", timestampMs: 1000 }];
    const speakerLabels = [{ speakerName: "Ana", timestampMs: 950 }];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Beto", text: "Hola", timestampMs: 1000 },
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

  it("locks its own name by majority vote and ignores a one-off window from a different person for a 'You' caption", () => {
    // Reproduce el bug real encontrado en la Tarea 8: el usuario habla varias
    // veces (matcheando su propia ventana), pero en un momento el indicador
    // de "Fulano" se solapa por casualidad con una de sus captions "You". Sin
    // el voto de mayoría, esa caption se hubiera atribuido incorrectamente a
    // "Fulano (You)" - con él, la identidad ya establecida ("Ivan Gonzalez")
    // gana, y la caption que solo matchea a Fulano cae al fallback seguro.
    const captions = [
      { speaker: "You", text: "Hola", timestampMs: 1000 },
      { speaker: "You", text: "sigo hablando", timestampMs: 3000 },
      { speaker: "You", text: "esto en realidad lo dije yo", timestampMs: 5000 },
      { speaker: "You", text: "y esto también", timestampMs: 7000 },
    ];
    const speakerLabels = [
      { speakerName: "Ivan Gonzalez", timestampMs: 950 },
      { speakerName: "Ivan Gonzalez", timestampMs: 2950 },
      { speakerName: "Fulano Detal", timestampMs: 4950 },
      { speakerName: "Ivan Gonzalez", timestampMs: 6950 },
    ];
    expect(reconcileCaptionSnapshots({ captions, speakerLabels })).toEqual([
      { speaker: "Ivan Gonzalez (You)", text: "Hola", timestampMs: 1000 },
      { speaker: "Ivan Gonzalez (You)", text: "sigo hablando", timestampMs: 3000 },
      { speaker: "You", text: "esto en realidad lo dije yo", timestampMs: 5000 },
      { speaker: "Ivan Gonzalez (You)", text: "y esto también", timestampMs: 7000 },
    ]);
  });
});
