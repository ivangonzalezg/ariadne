import { afterEach, describe, expect, it, vi } from "vitest";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";

let stop;
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function setup({ enabled = true, linked = false } = {}) {
  vi.useFakeTimers();
  document.body.innerHTML = `<button jsname="RrG0hf" ${linked ? 'aria-controls="captions"' : ""}><i>${enabled ? "closed_caption" : "closed_caption_off"}</i></button><div role="region" id="captions"></div>`;
  const button = document.querySelector("button");
  button.addEventListener("click", () => { button.querySelector("i").textContent = "closed_caption"; });
  return { button, region: document.getElementById("captions") };
}

function speak(region, text = "Hola") {
  region.innerHTML = `<div class="nMcdL bj4p3b"><span class="NWpY1d">Ana</span><span class="ygicle VbkSUe">${text}</span></div>`;
}

describe("caption capture lifecycle", () => {
  it("captures the first intervention after a minute of silence", async () => {
    const { region } = setup();
    const onSnapshot = vi.fn();
    stop = await enableCaptionsAndObserve(onSnapshot);
    await vi.advanceTimersByTimeAsync(60000);
    speak(region);
    await vi.advanceTimersByTimeAsync(500);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ speaker: "Ana", text: "Hola" }));
  });

  it("reports active before any text when captions are enabled", async () => {
    setup();
    const onActiveChange = vi.fn();
    stop = await enableCaptionsAndObserve(vi.fn(), { onActiveChange });
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("enables captions and reports readiness without speech", async () => {
    const { button } = setup({ enabled: false });
    const click = vi.spyOn(button, "click");
    const onActiveChange = vi.fn();
    stop = await enableCaptionsAndObserve(vi.fn(), { onActiveChange });
    await vi.advanceTimersByTimeAsync(1000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("retries activation if the first click did not enable captions", async () => {
    const { button } = setup({ enabled: false });
    const click = vi.spyOn(button, "click").mockImplementationOnce(() => {});
    const onActiveChange = vi.fn();
    stop = await enableCaptionsAndObserve(vi.fn(), { onActiveChange });
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(click).toHaveBeenCalledTimes(2);
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("excludes baseline text but captures its later revisions", async () => {
    const { region } = setup();
    speak(region);
    const onSnapshot = vi.fn();
    stop = await enableCaptionsAndObserve(onSnapshot);
    expect(onSnapshot).not.toHaveBeenCalled();
    region.querySelector(".ygicle").textContent = "Hola nueva";
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reconnects when Meet replaces the caption panel", async () => {
    const { region } = setup();
    speak(region);
    const onSnapshot = vi.fn();
    stop = await enableCaptionsAndObserve(onSnapshot);
    const replacement = document.createElement("div");
    replacement.setAttribute("role", "region");
    replacement.id = "captions";
    region.replaceWith(replacement);
    speak(replacement, "Segunda intervención");
    await vi.advanceTimersByTimeAsync(500);
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Segunda intervención" }));
  });

  it("cancels discovery when stopped before the first intervention", async () => {
    const { region } = setup();
    const onSnapshot = vi.fn();
    stop = await enableCaptionsAndObserve(onSnapshot);
    stop();
    speak(region);
    await vi.advanceTimersByTimeAsync(60000);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops an attached observer and reports inactive", async () => {
    const { region } = setup();
    speak(region);
    const onSnapshot = vi.fn();
    const onActiveChange = vi.fn();
    stop = await enableCaptionsAndObserve(onSnapshot, { onActiveChange });
    onSnapshot.mockClear();
    stop();
    speak(region, "Después de detener");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("finds the toggle even when it appears after a minute", async () => {
    setup();
    document.body.innerHTML = "";
    const onActiveChange = vi.fn();
    stop = await enableCaptionsAndObserve(vi.fn(), { onActiveChange });
    await vi.advanceTimersByTimeAsync(60000);
    document.body.innerHTML = '<button jsname="RrG0hf"><i>closed_caption</i></button>';
    await vi.advanceTimersByTimeAsync(500);
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("observes an empty panel linked to the toggle", async () => {
    const { region } = setup({ linked: true });
    const onSnapshot = vi.fn();
    stop = await enableCaptionsAndObserve(onSnapshot);
    speak(region);
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not emit blank text or repeat unchanged snapshots on polling", async () => {
    const { region } = setup();
    speak(region, "   ");
    const onSnapshot = vi.fn();
    stop = await enableCaptionsAndObserve(onSnapshot);
    expect(onSnapshot).not.toHaveBeenCalled();
    region.querySelector('.ygicle').textContent = "Hola";
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    region.querySelector('.ygicle').textContent = "Hola a todos";
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });
});

it("reads multiple new blocks and retains two identical phrases by the same speaker", async () => {
  const { region } = setup({ linked: true }); const onSnapshot = vi.fn();
  stop = enableCaptionsAndObserve(onSnapshot);
  region.innerHTML = '<div class="nMcdL bj4p3b"><span class="NWpY1d">Ana</span><span class="ygicle VbkSUe">Hola</span></div>'.repeat(2);
  await Promise.resolve();
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  expect(new Set(onSnapshot.mock.calls.map(([e]) => e.utteranceId)).size).toBe(2);
  region.querySelector(".ygicle").textContent = "Hola a todos";
  await Promise.resolve();
  expect(onSnapshot.mock.calls.at(-1)[0]).toMatchObject({ utteranceId: onSnapshot.mock.calls[0][0].utteranceId, revision: 2 });
});

it("captures a removed block from the mutation record before stop", async () => {
  const { region } = setup({ linked: true }); const onSnapshot = vi.fn();
  stop = enableCaptionsAndObserve(onSnapshot); speak(region, "Última frase");
  region.firstChild.remove(); stop();
  expect(onSnapshot).toHaveBeenCalledOnce(); expect(onSnapshot.mock.calls[0][0].text).toBe("Última frase");
});

it("reuses unique identity across panel replacement without duplicating prior text", async () => {
  const { region } = setup({ linked: true }); const onSnapshot = vi.fn();
  stop = enableCaptionsAndObserve(onSnapshot); speak(region); await Promise.resolve();
  const previous = onSnapshot.mock.calls[0][0];
  const replacement = region.cloneNode(true); region.replaceWith(replacement);
  await vi.advanceTimersByTimeAsync(500); expect(onSnapshot).toHaveBeenCalledOnce();
  replacement.querySelector(".ygicle").textContent = "Hola revisada"; await Promise.resolve();
  expect(onSnapshot.mock.calls.at(-1)[0]).toMatchObject({ utteranceId: previous.utteranceId, revision: 2 });
});
