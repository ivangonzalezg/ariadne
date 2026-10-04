import { afterEach, describe, expect, it, vi } from "vitest";
import { captionToggleState, createCaptionControl } from "./meet-caption-control.js";
let control;
afterEach(() => { control?.dispose(); vi.useRealTimers(); document.body.innerHTML = ""; });
function button(state) { document.body.innerHTML = `<button jsname="RrG0hf" aria-pressed="${state}"><i>closed_caption_off</i></button>`; return document.querySelector("button"); }
describe("caption controls", () => {
  it("prioritizes accessible state and never toggles unknown buttons", () => {
    const toggle = button("true"); expect(captionToggleState(toggle)).toBe("on");
    toggle.removeAttribute("aria-pressed"); toggle.innerHTML = "CC";
    const click = vi.spyOn(toggle, "click"); control = createCaptionControl();
    expect(control.sync().ccState).toBe("unknown"); expect(click).not.toHaveBeenCalled();
  });
  it("respects trusted disable across button replacement, then resumes on manual enable", () => {
    vi.useFakeTimers(); const toggle = button("true"); control = createCaptionControl(); control.sync();
    control.handleUserToggle({ isTrusted: true, target: toggle }); toggle.setAttribute("aria-pressed", "false");
    expect(control.sync().state).toBe("paused");
    const next = button("false"), click = vi.spyOn(next, "click");
    vi.advanceTimersByTime(60000); expect(control.sync().state).toBe("paused"); expect(click).not.toHaveBeenCalled();
    next.setAttribute("aria-pressed", "true"); expect(control.sync().state).toBe("active");
  });
  it("does not confuse extension clicks with a user's change", () => {
    const toggle = button("false"); toggle.addEventListener("click", () => toggle.setAttribute("aria-pressed", "true"));
    control = createCaptionControl(); expect(control.sync().state).toBe("active");
  });
});
