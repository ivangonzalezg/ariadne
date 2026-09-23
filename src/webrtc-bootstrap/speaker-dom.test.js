import { describe, expect, it } from "vitest";
import { findSpeakerAwareIndicators, extractSpeakerNameFromIndicator } from "./speaker-dom.js";

// Forma validada contra una reunión real de Meet (ver Tarea 8 del plan): un
// único <div jscontroller> con __soy.key incluyendo "speakerAwareVolumeIndicator"
// y un solo hijo - no tres hijos con extremos sin hijos propios, como asumía
// una versión anterior de este archivo.
function makeIndicator({ soyKey = "iEqC6d27:speakerAwareVolumeIndicator", childCount = 1 } = {}) {
  const el = document.createElement("div");
  el.setAttribute("jscontroller", "abc123");
  el.__soy = { key: soyKey };
  for (let i = 0; i < childCount; i++) {
    el.appendChild(document.createElement("div"));
  }
  return el;
}

describe("findSpeakerAwareIndicators", () => {
  it("finds a div with jscontroller and __soy.key including speakerAwareVolumeIndicator", () => {
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

  it("ignores divs whose __soy.key does not include speakerAwareVolumeIndicator", () => {
    document.body.innerHTML = "";
    document.body.appendChild(makeIndicator({ soyKey: "somethingElse" }));
    expect(findSpeakerAwareIndicators()).toEqual([]);
  });

  it("ignores divs without jscontroller even if __soy.key would otherwise match", () => {
    document.body.innerHTML = "";
    const el = document.createElement("div");
    el.__soy = { key: "iEqC6d27:speakerAwareVolumeIndicator" };
    document.body.appendChild(el);
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

  it("keeps climbing past an ancestor with __soy.data that has no usable name (real Meet DOM has these)", () => {
    // Caso real encontrado en producción (Tarea 8): el indicador vive dentro
    // de varios wrappers intermedios que sí tienen __soy.data (ej. solo con
    // clases CSS y una función de render) pero sin ningún nombre - el nombre
    // real está más arriba. Antes de esta corrección, la función se rendía en
    // el primer wrapper y nunca llegaba al ancestro correcto.
    const indicator = makeIndicator();
    const emptyWrapper = document.createElement("div");
    emptyWrapper.__soy = { data: { rF: "some-css-class", content: () => {} } };
    const grandparent = document.createElement("div");
    const space = new Array(29).fill(null);
    space[28] = "Iván González";
    grandparent.__soy = { data: { uc: { zn: space } } };

    emptyWrapper.appendChild(indicator);
    grandparent.appendChild(emptyWrapper);
    expect(extractSpeakerNameFromIndicator(indicator)).toBe("Iván González");
  });

  it("returns null when position 28 is not a non-empty string anywhere up the tree", () => {
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
