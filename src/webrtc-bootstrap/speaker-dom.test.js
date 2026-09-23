import { describe, expect, it } from "vitest";
import { findSpeakerAwareIndicators, extractSpeakerNameFromIndicator } from "./speaker-dom.js";

function makeIndicator({ soyKey = "someprefix_speakerAware_suffix", childCount = 3, firstHasChildren = false, lastHasChildren = false } = {}) {
  const el = document.createElement("div");
  el.setAttribute("jscontroller", "abc123");
  el.__soy = { key: soyKey };
  for (let i = 0; i < childCount; i++) {
    const child = document.createElement("span");
    if (i === 0 && firstHasChildren) child.appendChild(document.createElement("i"));
    if (i === childCount - 1 && lastHasChildren) child.appendChild(document.createElement("i"));
    el.appendChild(child);
  }
  return el;
}

describe("findSpeakerAwareIndicators", () => {
  it("finds a div with jscontroller and __soy.key including speakerAware, 3 childless-edge children", () => {
    document.body.innerHTML = "";
    const indicator = makeIndicator();
    document.body.appendChild(indicator);
    expect(findSpeakerAwareIndicators()).toEqual([indicator]);
  });

  it("ignores divs without __soy", () => {
    document.body.innerHTML = "";
    const el = document.createElement("div");
    el.setAttribute("jscontroller", "abc123");
    document.body.appendChild(el);
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });

  it("ignores divs whose __soy.key does not include speakerAware", () => {
    document.body.innerHTML = "";
    document.body.appendChild(makeIndicator({ soyKey: "somethingElse" }));
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });

  it("ignores divs without exactly 3 children", () => {
    document.body.innerHTML = "";
    document.body.appendChild(makeIndicator({ childCount: 2 }));
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });

  it("ignores divs whose first or last child already has child nodes", () => {
    document.body.innerHTML = "";
    document.body.appendChild(makeIndicator({ firstHasChildren: true }));
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });
});

describe("extractSpeakerNameFromIndicator", () => {
  it("reads the name from the nearest ancestor's __soy.data at position 28", () => {
    const indicator = makeIndicator();
    const parent = document.createElement("div");
    const space = new Array(29).fill(null);
    space[28] = "Ivan Gonzalez";
    parent.__soy = { data: { someKey: { innerKey: space } } };
    parent.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBe("Ivan Gonzalez");
  });

  it("climbs multiple levels until it finds an ancestor with __soy.data", () => {
    const indicator = makeIndicator();
    const grandparent = document.createElement("div");
    const parent = document.createElement("div");
    const space = new Array(29).fill(null);
    space[28] = "Ana";
    grandparent.__soy = { data: { k: { j: space } } };
    parent.appendChild(indicator);
    grandparent.appendChild(parent);
    expect(extractSpeakerNameFromIndicator(indicator)).toBe("Ana");
  });

  it("returns null when no ancestor has __soy.data", () => {
    const indicator = makeIndicator();
    document.body.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBeNull();
  });

  it("returns null when position 28 is not a non-empty string", () => {
    const indicator = makeIndicator();
    const parent = document.createElement("div");
    parent.__soy = { data: { k: { j: new Array(29).fill(null) } } };
    parent.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBeNull();
  });

  it("returns null and does not throw when position 28 is a suspiciously long string", () => {
    const indicator = makeIndicator();
    const parent = document.createElement("div");
    const space = new Array(29).fill(null);
    space[28] = "x".repeat(500);
    parent.__soy = { data: { k: { j: space } } };
    parent.appendChild(indicator);
    expect(extractSpeakerNameFromIndicator(indicator)).toBeNull();
  });
});
