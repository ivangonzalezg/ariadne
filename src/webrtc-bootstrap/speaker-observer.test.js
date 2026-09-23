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

  it("emits a silence label (speakerName: null) after MAX_SILENCE_DURATION_MS of no change", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();
    vi.advanceTimersByTime(2000);
    await flush();

    expect(onSpeakerLabel).toHaveBeenLastCalledWith({ speakerName: null, timestampMs: expect.any(Number) });
    stop();
  });

  it("renews the silence timer on repeated activity from the same speaker instead of timing out", async () => {
    const indicator = appendIndicatorWithName("Ivan Gonzalez");
    const onSpeakerLabel = vi.fn();
    const stop = startSpeakerObserver({ onSpeakerLabel });

    indicator.setAttribute("class", "is-speaking");
    await flush();
    vi.advanceTimersByTime(1500);
    indicator.setAttribute("class", "is-speaking-again");
    await flush();
    vi.advanceTimersByTime(1500);
    await flush();

    // Pasaron 3000ms en total, pero la actividad a los 1500ms debió reiniciar
    // el timer de silencio — todavía no deberían pasar 2000ms sin actividad.
    expect(onSpeakerLabel).not.toHaveBeenCalledWith({ speakerName: null, timestampMs: expect.any(Number) });
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
