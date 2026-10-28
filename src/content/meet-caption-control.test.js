import { afterEach, describe, expect, it, vi } from "vitest";
import { captionToggleState, createCaptionControl } from "./meet-caption-control.js";
let control;
afterEach(() => { control?.dispose(); vi.useRealTimers(); document.body.innerHTML = ""; });
function button(state) { document.body.innerHTML = `<button jsname="RrG0hf" aria-pressed="${state}"><i>closed_caption_off</i></button>`; return document.querySelector("button"); }
describe("caption controls", () => {
  it("prefers the classic toggle when both interfaces are present", () => {
    document.body.innerHTML = '<button aria-label="Activar subtítulos" id="new-action"></button><button jsname="RrG0hf" aria-pressed="false" id="classic"><i>closed_caption_off</i></button><button aria-label="Subtítulos y traducción" aria-pressed="false" id="menu"></button>';
    const classic = document.getElementById("classic"), action = document.getElementById("new-action"), menu = document.getElementById("menu");
    const actionClick = vi.spyOn(action, "click"), menuClick = vi.spyOn(menu, "click");
    classic.addEventListener("click", () => classic.setAttribute("aria-pressed", "true"));
    control = createCaptionControl(); expect(control.sync().state).toBe("active");
    expect(classic.getAttribute("aria-pressed")).toBe("true");
    expect(actionClick).not.toHaveBeenCalled(); expect(menuClick).not.toHaveBeenCalled();
    // Both controls affect the same setting, even if the extension prefers one.
    action.setAttribute("aria-label", "Desactivar subtítulos instantáneos");
    control.handleUserToggle({ isTrusted: true, target: action });
    action.setAttribute("aria-label", "Activar subtítulos"); classic.setAttribute("aria-pressed", "false");
    expect(control.sync().state).toBe("paused");
  });

  it("falls back to the new panel when the classic control disappears", () => {
    const classic = button("true");
    control = createCaptionControl(); expect(control.sync().state).toBe("active"); classic.remove();
    const menu = document.createElement("button"); menu.setAttribute("aria-label", "Subtítulos y traducción"); menu.setAttribute("aria-pressed", "false");
    menu.addEventListener("click", () => menu.setAttribute("aria-pressed", "true"));
    document.body.append(menu);
    expect(control.sync().state).toBe("active"); expect(menu.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not open the new panel when a visible classic button has an unknown state", () => {
    document.body.innerHTML = '<button jsname="RrG0hf">CC</button><button aria-label="Subtítulos y traducción" aria-pressed="false"></button>';
    const menuClick = vi.spyOn(document.querySelectorAll("button")[1], "click");
    control = createCaptionControl(); expect(control.sync().state).toBe("preparing"); expect(menuClick).not.toHaveBeenCalled();
  });

  it("ignores a hidden classic control and enables captions through the new interface", () => {
    const classic = button("false"); classic.hidden = true;
    const classicClick = vi.spyOn(classic, "click");
    const menu = document.createElement("button"); menu.setAttribute("aria-label", "Subtítulos y traducción"); menu.setAttribute("aria-pressed", "false");
    menu.addEventListener("click", () => menu.setAttribute("aria-pressed", "true")); document.body.append(menu);
    control = createCaptionControl(); expect(control.sync().state).toBe("active"); expect(classicClick).not.toHaveBeenCalled();
  });

  it.each([
    ["Subtítulos y traducción", "Activar subtítulos", "Desactivar subtítulos instantáneos"],
    ["Captions and translation", "Turn on captions", "Turn off captions"],
    ["Sous-titres et traduction", "Activer les sous-titres", "Désactiver les sous-titres"],
  ])("enables captions from the new %s control without activating voice translation", (menuLabel, enableLabel, disableLabel) => {
    document.body.innerHTML = `<button aria-label="${menuLabel}" aria-pressed="false"></button>`;
    const menu = document.querySelector("button"), translate = vi.fn();
    menu.addEventListener("click", () => {
      if (document.querySelector("#caption-action")) return;
      const action = document.createElement("button"); action.id = "caption-action"; action.setAttribute("aria-label", enableLabel);
      action.addEventListener("click", () => { action.setAttribute("aria-label", disableLabel); menu.setAttribute("aria-pressed", "true"); });
      const translation = document.createElement("button"); translation.textContent = "Traducir voz"; translation.addEventListener("click", translate);
      document.body.append(action, translation);
    });
    control = createCaptionControl();
    expect(control.sync().state).toBe("active");
    expect(menu.getAttribute("aria-pressed")).toBe("true");
    expect(translate).not.toHaveBeenCalled();
  });

  it("waits for an asynchronously rendered panel and respects a manual pause after it closes", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button aria-label="Subtítulos y traducción" aria-pressed="false"></button>';
    const menu = document.querySelector("button"), click = vi.spyOn(menu, "click");
    menu.addEventListener("click", () => setTimeout(() => {
      const action = document.createElement("button"); action.id = "caption-action"; action.setAttribute("aria-label", "Activar subtítulos");
      action.addEventListener("click", () => { action.setAttribute("aria-label", "Desactivar subtítulos instantáneos"); menu.setAttribute("aria-pressed", "true"); });
      document.body.append(action);
    }, 100));
    control = createCaptionControl();
    expect(control.sync().state).toBe("preparing");
    vi.advanceTimersByTime(100);
    expect(control.sync().state).toBe("active");
    const action = document.getElementById("caption-action");
    control.handleUserToggle({ isTrusted: true, target: action });
    action.setAttribute("aria-label", "Activar subtítulos"); menu.setAttribute("aria-pressed", "false");
    expect(control.sync().state).toBe("paused");
    action.remove(); vi.advanceTimersByTime(60000);
    expect(control.sync().state).toBe("paused"); expect(click).toHaveBeenCalledOnce();
    menu.setAttribute("aria-pressed", "true"); expect(control.sync().state).toBe("active");
  });

  it("ignores hidden caption actions and treats an enable label as off despite a closed_caption icon", () => {
    document.body.innerHTML = '<button hidden aria-label="Desactivar subtítulos instantáneos"></button><button aria-label="Activar subtítulos"><i>closed_caption</i></button>';
    const action = document.querySelectorAll("button")[1];
    expect(captionToggleState(action)).toBe("off");
    action.addEventListener("click", () => action.setAttribute("aria-label", "Desactivar subtítulos instantáneos"));
    control = createCaptionControl(); expect(control.sync().state).toBe("active");
  });

  it("supports a hover-only caption panel", () => {
    document.body.innerHTML = '<button aria-label="Subtítulos y traducción" aria-pressed="false"></button>';
    const menu = document.querySelector("button");
    menu.addEventListener("mouseenter", () => {
      const action = document.createElement("button"); action.textContent = "Habilitar subtítulos";
      action.addEventListener("click", () => { action.setAttribute("aria-label", "Desactivar subtítulos instantáneos"); menu.setAttribute("aria-pressed", "true"); });
      document.body.append(action);
    }, { once: true });
    control = createCaptionControl(); expect(control.sync().state).toBe("active");
  });

  it("does not keep reopening the panel when captions are already active", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button aria-label="Subtítulos y traducción" aria-pressed="true"></button>';
    const menu = document.querySelector("button"), click = vi.spyOn(menu, "click");
    control = createCaptionControl(); expect(control.sync().state).toBe("active");
    vi.advanceTimersByTime(60000); expect(control.sync().state).toBe("active"); expect(click).not.toHaveBeenCalled();
  });

  it("respects a manual disable performed through the combined control", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button aria-label="Subtítulos y traducción" aria-pressed="true"></button>';
    const menu = document.querySelector("button"), click = vi.spyOn(menu, "click");
    control = createCaptionControl(); control.sync();
    control.handleUserToggle({ isTrusted: true, target: menu }); menu.setAttribute("aria-pressed", "false");
    expect(control.sync().state).toBe("paused");
    vi.advanceTimersByTime(60000); expect(control.sync().state).toBe("paused"); expect(click).not.toHaveBeenCalled();
  });

  it("skips disabled caption actions", () => {
    document.body.innerHTML = '<button disabled aria-label="Activar subtítulos"></button>';
    const click = vi.spyOn(document.querySelector("button"), "click");
    control = createCaptionControl(); expect(control.sync().state).toBe("preparing"); expect(click).not.toHaveBeenCalled();
  });

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
