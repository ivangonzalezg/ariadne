// src/shared/i18n/i18n.js
export const SUPPORTED_LOCALES = ["en", "es", "fr"];
export const DEFAULT_LOCALE = "en";
export const LOCALE_TAGS = { en: "en-US", es: "es-ES", fr: "fr-FR" };

export function detectLocale(rawLocale) {
  if (!rawLocale) return DEFAULT_LOCALE;
  const normalized = String(rawLocale).toLowerCase().split("-")[0];
  return SUPPORTED_LOCALES.includes(normalized) ? normalized : DEFAULT_LOCALE;
}

export function mergeWithFallback(target, fallback) {
  return { ...fallback, ...target };
}

export function interpolate(value, params) {
  if (typeof value !== "string" || !params) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function makeTranslator(dict) {
  return (key, params) => interpolate(key in dict ? dict[key] : key, params);
}

async function fetchDictionary(locale) {
  const url = chrome.runtime.getURL(`src/shared/i18n/locales/${locale}.json`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load the "${locale}" dictionary: HTTP ${response.status}`);
  return response.json();
}

async function safeFetchDictionary(locale) {
  try {
    return await fetchDictionary(locale);
  } catch (error) {
    console.error(`[i18n] could not load the "${locale}" dictionary`, error);
    return {};
  }
}

export async function initI18n(rawLocale = navigator.language) {
  const locale = detectLocale(rawLocale);
  const fallbackDict = locale === DEFAULT_LOCALE ? {} : await safeFetchDictionary(DEFAULT_LOCALE);
  const targetDict = await safeFetchDictionary(locale);
  const dict = mergeWithFallback(targetDict, fallbackDict);
  document.documentElement.lang = locale;
  return { locale, localeTag: LOCALE_TAGS[locale], t: makeTranslator(dict) };
}
