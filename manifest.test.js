import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";

describe("manifest.json localization", () => {
  it("declares default_locale so chrome.i18n can resolve __MSG_ placeholders", () => {
    expect(manifest.default_locale).toBe("en");
  });

  it("references the localized name and description via __MSG_ placeholders", () => {
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.description).toBe("__MSG_extensionDescription__");
  });

  it("exposes the i18n locale dictionaries to the Meet content script", () => {
    const meetResources = manifest.web_accessible_resources.find((entry) =>
      entry.matches.includes("https://meet.google.com/*")
    );
    expect(meetResources.resources).toEqual(
      expect.arrayContaining([
        "src/shared/i18n/locales/en.json",
        "src/shared/i18n/locales/es.json",
        "src/shared/i18n/locales/fr.json",
      ])
    );
  });
});
