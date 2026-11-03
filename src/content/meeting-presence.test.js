import { afterEach, describe, expect, it, vi } from "vitest";
import { isInActiveMeeting, observeMeetingPresence } from "./meeting-presence.js";
import { isInTeamsMeeting } from "./teams-selectors.js";
import { findByIconText } from "./meet-selectors.js";
import { isVisible as isTeamsVisible } from "./teams-selectors.js";
import { getMeetingPlatform } from "./meeting-platform.js";

let dispose;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("meeting presence", () => {
  it("uses Teams controls for exit and reentry when observing its platform", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    dispose = observeMeetingPresence(onChange, { isActive: isInTeamsMeeting });
    document.body.innerHTML = '<button id="hangup-button">Leave</button>';
    await flush();
    document.querySelector("button").hidden = true;
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    document.querySelector("button").hidden = false;
    await flush();
    expect(onChange.mock.calls.map(([active]) => active)).toEqual([false, true, false, true]);
  });

  it("ignores hidden controls and finds a visible icon after a stale hidden icon", () => {
    document.body.innerHTML = '<div hidden><button><i>call_end</i></button></div>';
    expect(isInActiveMeeting()).toBe(false);
    document.body.insertAdjacentHTML("beforeend", '<button><i>call_end</i></button>');
    expect(isInActiveMeeting()).toBe(true);
  });

  it.each(['hidden', 'style="display:none"', 'style="visibility:hidden"', 'style="visibility:collapse"'])("ignores a control inside %s", attribute => {
    document.body.innerHTML = `<div ${attribute}><button><i>call_end</i></button></div>`;
    expect(isInActiveMeeting()).toBe(false);
  });

  it("accepts decorative icons with aria-hidden inside a visible control", () => {
    document.body.innerHTML = '<button><i aria-hidden="true">call_end</i></button>';
    expect(isInActiveMeeting()).toBe(true);
  });

  it("detects Meet's visible leave button with an aria-hidden icon wrapper", () => {
    document.body.innerHTML = '<button aria-label="Leave call"><span aria-hidden="true"><i aria-hidden="true">call_end</i></span></button>';
    expect(isInActiveMeeting()).toBe(true);
    document.querySelector("button").setAttribute("aria-hidden", "true");
    expect(isInActiveMeeting()).toBe(true);
  });

  it("still rejects CSS-hidden decorative wrappers inside visible controls", () => {
    document.body.innerHTML = '<button><span aria-hidden="true" style="display:none"><i>call_end</i></span></button>';
    expect(isInActiveMeeting()).toBe(false);
  });

  it("keeps watching exit and reentry without URL navigation", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    dispose = observeMeetingPresence(onChange);
    const url = location.href;
    document.body.innerHTML = '<button><i>call_end</i></button>';
    await flush();
    const button = document.querySelector("button");
    button.hidden = true;
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    button.hidden = false;
    await flush();
    expect(onChange.mock.calls.map(([active]) => active)).toEqual([false, true, false, true]);
    expect(location.href).toBe(url);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces synchronous control replacements without a false exit", async () => {
    document.body.innerHTML = '<button><i>call_end</i></button>';
    const onChange = vi.fn();
    dispose = observeMeetingPresence(onChange);
    document.querySelector("button").remove();
    document.body.innerHTML = '<button><i>call_end</i></button>';
    await flush();
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it.each(["meet", "teams"])("keeps %s presence through repeated modal isolation without changing interactive visibility", async platform => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="background"><button id="hangup-button"><i>call_end</i></button></div><div role="dialog">Consent</div>';
    const background = document.getElementById("background");
    const detector = getMeetingPlatform(platform === "meet" ? "https://meet.google.com/abc" : "https://teams.microsoft.com/").isInActiveMeeting;
    const onChange = vi.fn();
    dispose = observeMeetingPresence(onChange, { isActive: detector });
    for (let repeat = 0; repeat < 2; repeat++) {
      background.setAttribute("aria-hidden", "true"); background.setAttribute("inert", "");
      await flush(); await vi.advanceTimersByTimeAsync(10000);
      expect(detector()).toBe(true);
      expect(findByIconText("call_end", { visible: true })).toBeNull();
      expect(isTeamsVisible(document.querySelector("button"))).toBe(false);
      background.removeAttribute("aria-hidden"); background.removeAttribute("inert");
      await flush();
    }
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it.each(["hidden", "removed"])("tolerates a %s control across separate turns and starts a fresh deadline for a later exit", async mode => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button><i>call_end</i></button>';
    const button = document.querySelector("button"), onChange = vi.fn();
    dispose = observeMeetingPresence(onChange);
    if (mode === "hidden") button.hidden = true; else button.remove();
    await flush(); await vi.advanceTimersByTimeAsync(2999);
    expect(onChange.mock.calls).toEqual([[true]]);
    button.hidden = false; document.body.append(button);
    await flush(); await vi.advanceTimersByTimeAsync(5000);
    expect(onChange.mock.calls).toEqual([[true]]);
    button.remove(); await flush();
    await vi.advanceTimersByTimeAsync(2999);
    expect(onChange.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("does not postpone confirmation during DOM churn or publish an exit twice", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button><i>call_end</i></button>';
    const onChange = vi.fn(); dispose = observeMeetingPresence(onChange);
    document.querySelector("button").remove(); await flush();
    for (let tick = 0; tick < 5; tick++) {
      await vi.advanceTimersByTimeAsync(500);
      document.body.append(document.createElement("div")); await flush();
    }
    expect(onChange.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    await vi.advanceTimersByTimeAsync(9000);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("rechecks presence at the deadline even without a mutation notification", async () => {
    vi.useFakeTimers(); let active = true;
    const onChange = vi.fn(); dispose = observeMeetingPresence(onChange, { isActive: () => active });
    active = false; await vi.advanceTimersByTimeAsync(3000);
    active = true; await vi.advanceTimersByTimeAsync(3000);
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it("cancels the exit timer and queued checks on disposal", async () => {
    vi.useFakeTimers(); document.body.innerHTML = '<button><i>call_end</i></button>';
    const onChange = vi.fn(); dispose = observeMeetingPresence(onChange);
    document.querySelector("button").remove(); await flush();
    expect(vi.getTimerCount()).toBe(2);
    document.body.append(document.createElement("div"));
    dispose(); await flush(); await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
    expect(onChange.mock.calls).toEqual([[true]]);
  });
});
