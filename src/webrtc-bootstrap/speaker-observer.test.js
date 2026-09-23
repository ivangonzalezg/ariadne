import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpeakerObserver } from "./speaker-observer.js";

// Forma validada contra una reunión real de Meet (ver Tarea 8 del plan): el
// indicador es un <div jscontroller> con un solo hijo y __soy.key conteniendo
// "speakerAwareVolumeIndicator"; el nombre vive en __soy.data de un ancestro
// (no necesariamente el padre directo).
function appendIndicatorWithName(name) {
  const parent = document.createElement("div");
  const space = new Array(29).fill(null);
  space[28] = name;
  parent.__soy = { data: { k: { j: space } } };

  const indicator = document.createElement("div");
  indicator.setAttribute("jscontroller", "abc");
  indicator.__soy = { key: "iEqC6d27:speakerAwareVolumeIndicator" };
  indicator.appendChild(document.createElement("div"));

  parent.appendChild(indicator);
  document.body.appendChild(parent);
  return indicator;
}

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

describe("startSpeakerObserver", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a label when a speaker-aware indicator's attributes change", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();

    expect(onSpeakerLabel).toHaveBeenCalledWith({ speakerName: "Ivan Gonzalez", timestampMs: expect.any(Number) });
    stop();
  });

  it("does not emit twice in a row for the same speaker", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();
    indicator.setAttribute("class", "is-speaking-still");
    await flush();

    expect(onSpeakerLabel).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps the window open across a long gap with no further mutation (no synthetic silence timeout)", async () => {
    // Verificado contra una reunión real (Tarea 8): el indicador de Meet no
    // pulsa de forma continua mientras alguien sigue hablando, así que un
    // timeout sintético le cortaba la cobertura sin ninguna señal real. Ya no
    // existe ese timeout — pasar mucho tiempo sin otra mutación no debe
    // emitir ningún label adicional (ni "silencio" ni repetido).
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();
    vi.advanceTimersByTime(60000);
    await flush();

    expect(onSpeakerLabel).toHaveBeenCalledTimes(1);
    expect(onSpeakerLabel).toHaveBeenCalledWith({ speakerName: "Ivan Gonzalez", timestampMs: expect.any(Number) });
    stop();
  });

  it("emits again when a different speaker's indicator changes after a gap", async () => {
    const indicatorA = appendIndicatorWithName("Ivan Gonzalez");
    const indicatorB = appendIndicatorWithName("Fulano Detal");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicatorA.setAttribute("class", "is-speaking");
    await flush();
    vi.advanceTimersByTime(10000);
    indicatorB.setAttribute("class", "is-speaking");
    await flush();

    expect(onSpeakerLabel).toHaveBeenCalledTimes(2);
    expect(onSpeakerLabel).toHaveBeenLastCalledWith({ speakerName: "Fulano Detal", timestampMs: expect.any(Number) });
    stop();
  });

  it("stop() disconnects observers so no further labels are emitted", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });
    stop();

    indicator.setAttribute("class", "is-speaking");
    await flush();

    expect(onSpeakerLabel).not.toHaveBeenCalled();
  });

  it("does not throw and does not emit when there are no indicators in the DOM", () => {
    const onSpeakerLabel = vi.fn();
    expect(() => startSpeakerObserver({ onSpeakerLabel })).not.toThrow();
    expect(onSpeakerLabel).not.toHaveBeenCalled();
  });
});
