import { describe, expect, it } from "vitest";
import { MuteManifest } from "./mute-manifest.js";

describe("MuteManifest", () => {
  it("starts with no unmuted intervals", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    expect(m.toJSON().intervals).toEqual([]);
  });

  it("records one unmuted interval when unmuted then muted", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onUnmuted(1500);
    m.onMuted(2500);
    expect(m.toJSON().intervals).toEqual([{ startMs: 500, endMs: 1500 }]);
  });

  it("closes an open interval at finalize time", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onUnmuted(1500);
    m.finalize(3000);
    expect(m.toJSON().intervals).toEqual([{ startMs: 500, endMs: 2000 }]);
  });

  it("ignores a duplicate onUnmuted while already unmuted", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onUnmuted(1500);
    m.onUnmuted(1800);
    m.onMuted(2000);
    expect(m.toJSON().intervals).toEqual([{ startMs: 500, endMs: 1000 }]);
  });

  it("ignores a duplicate onMuted while already muted", () => {
    const m = new MuteManifest({ startedAt: 1000 });
    m.onMuted(1500);
    expect(m.toJSON().intervals).toEqual([]);
  });
});
