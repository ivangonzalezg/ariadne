import { describe, expect, it } from "vitest";
import { meetingDownloadFilename } from "./download-filename.js";
import { makeTranslator } from "../shared/i18n/i18n.js";
import en from "../shared/i18n/locales/en.json";
import es from "../shared/i18n/locales/es.json";
import fr from "../shared/i18n/locales/fr.json";

describe("meetingDownloadFilename", () => {
  it.each([
    ["  Reunión:  sobre   algo!  ", "reunion-sobre-algo"],
    ["Reunión -- sobre - algo", "reunion-sobre-algo"],
    ["Plan 2026: café / diseño 🚀", "plan-2026-cafe-diseno"],
    ["\tReunión\n sobre\t algo", "reunion-sobre-algo"],
    ["東京 2026", "東京-2026"],
    ["--- : 🚀 ---", "untitled-meeting"],
    ["", "untitled-meeting"],
    [null, "untitled-meeting"],
  ])("normalizes %j into a readable title", (title, expected) => {
    expect(meetingDownloadFilename(title, "Video", "mp4", en["common.untitledMeeting"])).toBe(`${expected}-video.mp4`);
  });

  it.each([
    [en, "transcript", "manifest", "untitled-meeting"],
    [es, "transcripcion", "manifiesto", "reunion-sin-titulo"],
    [fr, "transcription", "manifeste", "reunion-sans-titre"],
  ])("uses translated labels and fallback titles", (dictionary, transcript, manifest, fallback) => {
    const t = makeTranslator(dictionary);
    expect(meetingDownloadFilename("Planning 2026", t("common.transcript"), "txt", t("common.untitledMeeting")))
      .toBe(`planning-2026-${transcript}.txt`);
    expect(meetingDownloadFilename("Planning 2026", t("common.manifest"), "json", t("common.untitledMeeting")))
      .toBe(`planning-2026-${manifest}.json`);
    expect(meetingDownloadFilename(" 🚀 : ", t("common.video"), "webm", t("common.untitledMeeting")))
      .toBe(`${fallback}-video.webm`);
  });
});
