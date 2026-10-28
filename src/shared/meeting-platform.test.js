import { describe, expect, it } from "vitest";
import { meetingPlatformForUrl, TEAMS_HOSTS } from "./meeting-platform.js";
import manifest from "../../manifest.json";

describe("meeting platform URLs", () => {
  it.each(TEAMS_HOSTS)("supports %s in every extension entry point", host => {
    expect(meetingPlatformForUrl(`https://${host}/v2/`)).toBe("teams");
    const match = `https://${host}/*`;
    expect(manifest.host_permissions).toContain(match);
    for (const entry of [...manifest.content_scripts, ...manifest.web_accessible_resources]) expect(entry.matches).toContain(match);
  });
  it("preserves Meet and rejects lookalike or unsupported origins", () => {
    expect(meetingPlatformForUrl("https://meet.google.com/abc-defg-hij")).toBe("meet");
    for (const url of [undefined, "invalid", "http://teams.microsoft.com/", "https://teams.microsoft.com.example.org/", "https://example.org/?teams.microsoft.com"]) {
      expect(meetingPlatformForUrl(url)).toBeNull();
    }
  });
});
