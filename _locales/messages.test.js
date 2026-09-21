import { describe, expect, it } from "vitest";
import en from "./en/messages.json";
import es from "./es/messages.json";
import fr from "./fr/messages.json";

describe("_locales messages", () => {
  for (const [name, dict] of [["en", en], ["es", es], ["fr", fr]]) {
    it(`${name} defines extensionName and extensionDescription with non-empty message strings`, () => {
      expect(typeof dict.extensionName.message).toBe("string");
      expect(dict.extensionName.message.length).toBeGreaterThan(0);
      expect(typeof dict.extensionDescription.message).toBe("string");
      expect(dict.extensionDescription.message.length).toBeGreaterThan(0);
    });
  }

  it("all three locales define the same set of keys", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });
});
