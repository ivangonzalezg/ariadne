import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  interpolate,
  makeTranslator,
  mergeWithFallback,
} from "./i18n.js";

describe("detectLocale", () => {
  it("matches an exact supported language code", () => {
    expect(detectLocale("es")).toBe("es");
    expect(detectLocale("fr")).toBe("fr");
    expect(detectLocale("en")).toBe("en");
  });

  it("matches the base language from a region-qualified tag", () => {
    expect(detectLocale("es-ES")).toBe("es");
    expect(detectLocale("es-419")).toBe("es");
    expect(detectLocale("fr-CA")).toBe("fr");
    expect(detectLocale("en-GB")).toBe("en");
  });

  it("falls back to English when the language isn't supported", () => {
    expect(detectLocale("pt-BR")).toBe("en");
    expect(detectLocale("de")).toBe("en");
  });

  it("falls back to English when no language is given", () => {
    expect(detectLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(detectLocale("")).toBe(DEFAULT_LOCALE);
  });

  it("is case-insensitive", () => {
    expect(detectLocale("ES-es")).toBe("es");
  });
});

describe("mergeWithFallback", () => {
  it("keeps the target's value when a key exists in both", () => {
    expect(mergeWithFallback({ a: "target" }, { a: "fallback" })).toEqual({ a: "target" });
  });

  it("uses the fallback's value when the key is missing from the target", () => {
    expect(mergeWithFallback({ a: "target" }, { a: "fallback", b: "fallback-only" })).toEqual({
      a: "target",
      b: "fallback-only",
    });
  });
});

describe("interpolate", () => {
  it("replaces {{name}} placeholders with params", () => {
    expect(interpolate("Hola {{name}}", { name: "Ana" })).toBe("Hola Ana");
  });

  it("leaves unmatched placeholders untouched", () => {
    expect(interpolate("Hola {{name}}", {})).toBe("Hola {{name}}");
  });

  it("returns non-string values unchanged", () => {
    const value = ["Lu", "Ma"];
    expect(interpolate(value, { name: "Ana" })).toBe(value);
  });
});

describe("makeTranslator", () => {
  it("returns the dictionary value for a known key", () => {
    const t = makeTranslator({ "common.play": "Reproducir" });
    expect(t("common.play")).toBe("Reproducir");
  });

  it("interpolates params into the dictionary value", () => {
    const t = makeTranslator({ "popup.processingMultiple": "Procesando {{count}} reuniones..." });
    expect(t("popup.processingMultiple", { count: 3 })).toBe("Procesando 3 reuniones...");
  });

  it("falls back to the key itself when missing from the dictionary", () => {
    const t = makeTranslator({});
    expect(t("missing.key")).toBe("missing.key");
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("includes es, en and fr", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "es", "fr"]);
  });
});

import enDict from "./locales/en.json";
import esDict from "./locales/es.json";
import frDict from "./locales/fr.json";
import { afterEach, vi } from "vitest";
import { initI18n } from "./i18n.js";

function mockDictionaryFetch(dictionariesByLocale) {
  globalThis.chrome = { runtime: { getURL: (path) => path } };
  globalThis.fetch = vi.fn((url) => {
    const locale = url.match(/locales\/([a-z]+)\.json$/)?.[1];
    const dict = dictionariesByLocale[locale];
    if (!dict) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => dict });
  });
}

describe("initI18n", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.chrome;
    delete globalThis.fetch;
    document.documentElement.lang = "";
  });

  it("loads and merges the target dictionary over the English fallback", async () => {
    mockDictionaryFetch({
      en: { "common.play": "Play", "common.pause": "Pause" },
      es: { "common.play": "Reproducir" },
    });
    const { t, locale, localeTag } = await initI18n("es-AR");
    expect(locale).toBe("es");
    expect(localeTag).toBe("es-ES");
    expect(t("common.play")).toBe("Reproducir");
    expect(t("common.pause")).toBe("Pause");
    expect(document.documentElement.lang).toBe("es");
  });

  it("uses the English dictionary directly when the detected locale is English", async () => {
    mockDictionaryFetch({ en: { "common.play": "Play" } });
    const { t } = await initI18n("en-GB");
    expect(t("common.play")).toBe("Play");
  });

  it("falls back to English for an unsupported locale", async () => {
    mockDictionaryFetch({ en: { "common.play": "Play" } });
    const { locale, t } = await initI18n("pt-BR");
    expect(locale).toBe("en");
    expect(t("common.play")).toBe("Play");
  });

  it("falls back to the English dictionary when the target locale fails to load", async () => {
    mockDictionaryFetch({ en: { "common.play": "Play" } }); // no "fr" entry -> fetch resolves ok:false
    const { t } = await initI18n("fr-FR");
    expect(t("common.play")).toBe("Play");
  });

  it("degrades to returning raw keys instead of throwing when every fetch fails", async () => {
    mockDictionaryFetch({}); // nothing resolves ok:true
    const { t } = await initI18n("es-ES");
    expect(t("common.play")).toBe("common.play");
  });
});

describe("dictionary completeness", () => {
  it("only ever defines keys in es/fr that also exist in the English dictionary", () => {
    const enKeys = new Set(Object.keys(enDict));
    for (const key of Object.keys(esDict)) expect(enKeys.has(key)).toBe(true);
    for (const key of Object.keys(frDict)) expect(enKeys.has(key)).toBe(true);
  });
});
