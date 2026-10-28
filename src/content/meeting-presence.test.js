import { afterEach, describe, expect, it, vi } from "vitest";
import { isInActiveMeeting, observeMeetingPresence } from "./meeting-presence.js";
import { isInTeamsMeeting } from "./teams-selectors.js";

let dispose;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("meeting presence", () => {
  it("uses Teams controls for exit and reentry when observing its platform", async () => {
    const onChange = vi.fn();
    dispose = observeMeetingPresence(onChange, { isActive: isInTeamsMeeting });
    document.body.innerHTML = '<button id="hangup-button">Leave</button>';
    await flush();
    document.querySelector("button").hidden = true;
    await flush();
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

  it.each(['hidden', 'style="display:none"', 'style="visibility:hidden"', 'aria-hidden="true"', 'inert'])("ignores a control inside %s", attribute => {
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
    expect(isInActiveMeeting()).toBe(false);
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
});
