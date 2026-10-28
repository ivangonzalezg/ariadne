import { afterEach, describe, expect, it, vi } from "vitest";
import { isInTeamsMeeting, getTeamsMeetingTitle } from "./teams-selectors.js";
import { observeTeamsMuteState, readTeamsMicMuted } from "./teams-mute-observer.js";
import { createTeamsCaptionControl } from "./teams-caption-control.js";
import { enableTeamsCaptionsAndObserve } from "./teams-caption-observer.js";
import { getMeetingPlatform } from "./meeting-platform.js";

let stop;
afterEach(() => { stop?.(); stop = null; document.body.innerHTML = ""; vi.useRealTimers(); });

function captions({ baseline = "", enabled = true } = {}) {
  vi.useFakeTimers();
  document.body.innerHTML = `<button id="closed-captions-button" aria-pressed="${enabled}">CC</button>
    <div data-tid="closed-captions-renderer">${baseline}</div>`;
  const button = document.querySelector("button"), panel = document.querySelector("[data-tid=closed-captions-renderer]");
  panel.hidden = !enabled;
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(next)); panel.hidden = !next;
  });
  return { button, panel };
}
const row = (speaker = "Ana", text = "Hola", id = "one") => `<div data-tid="closed-caption-chat-message" data-message-id="${id}"><span data-tid="author">${speaker}</span><span data-tid="closed-caption-text">${text}</span></div>`;

describe("Teams meeting and microphone", () => {
  it("ignores prejoin, lobby and hidden leave controls", () => {
    document.body.innerHTML = '<button id="prejoin-join-button">Join</button><div hidden><button id="hangup-button">Leave</button></div>';
    expect(isInTeamsMeeting()).toBe(false);
    document.querySelector("[hidden]").hidden = false;
    expect(isInTeamsMeeting()).toBe(true);
    document.body.insertAdjacentHTML("beforeend", '<h2 data-tid="chat-title">Sprint review</h2>');
    expect(getTeamsMeetingTitle()).toBe("Sprint review");
  });

  it.each([
    ["Unmute mic", true], ["Mute mic", false], ["Activar micrófono", true],
    ["Desactivar micrófono", false], ["Silenciar", false], ["Reactivar audio", true],
    ["Réactiver le micro", true], ["Désactiver le micro", false],
  ])("reads action label %s", (label, expected) => {
    const button = document.createElement("button"); button.setAttribute("aria-label", label);
    expect(readTeamsMicMuted(button)).toBe(expected);
  });

  it("starts muted without a control and follows replaced controls", async () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    stop = observeTeamsMuteState(onChange);
    expect(onChange).toHaveBeenLastCalledWith(true, expect.any(Number));
    document.body.innerHTML = '<button id="microphone-button" aria-label="Mute mic"></button>';
    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenLastCalledWith(false, expect.any(Number));
    document.body.innerHTML = '<button id="microphone-button" aria-label="Unmute mic"></button>';
    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenLastCalledWith(true, expect.any(Number));
    stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("forces DOM captions on Teams while preserving Meet preferences", () => {
    expect(getMeetingPlatform("https://teams.cloud.microsoft/v2/").captionMode("hybrid")).toBe("dom");
    expect(getMeetingPlatform("https://meet.google.com/abc").captionMode("hybrid")).toBe("hybrid");
  });
});

describe("Teams captions lifecycle", () => {
  it("enables captions before speech and excludes preexisting captions", async () => {
    const { panel, button } = captions({ enabled: false, baseline: row() });
    const onSnapshot = vi.fn(), onStatus = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot, { onStatus });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: "active" }));
    expect(onSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    panel.querySelector("[data-tid=closed-caption-text]").textContent = "Hola equipo";
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ speaker: "Ana", text: "Hola equipo", source: "dom" }));
  });

  it("updates an utterance, retains removed rows and splits recycled rows", async () => {
    const { panel } = captions(); const onSnapshot = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot);
    panel.innerHTML = row(); await Promise.resolve();
    const first = onSnapshot.mock.lastCall[0];
    const block = panel.firstElementChild;
    block.querySelector("[data-tid=closed-caption-text]").textContent = "Hola equipo";
    await Promise.resolve();
    expect(onSnapshot.mock.lastCall[0]).toMatchObject({ utteranceId: first.utteranceId, revision: 2, text: "Hola equipo" });
    block.setAttribute("data-message-id", "two");
    block.querySelector("[data-tid=author]").textContent = "Carlos";
    block.querySelector("[data-tid=closed-caption-text]").textContent = "Buenos días";
    await Promise.resolve();
    expect(onSnapshot.mock.lastCall[0].utteranceId).not.toBe(first.utteranceId);
    const transient = document.createElement("div"); transient.innerHTML = row("María", "Adiós", "three");
    panel.append(transient); transient.remove(); await Promise.resolve();
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ speaker: "María", text: "Adiós" }));
  });

  it("captures a recycled baseline row as a new intervention", async () => {
    const { panel } = captions({ baseline: row() }); const onSnapshot = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot);
    panel.firstElementChild.setAttribute("data-message-id", "new");
    panel.querySelector("[data-tid=closed-caption-text]").textContent = "Nueva intervención";
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("captures another speaker on a recycled baseline row without a message ID", async () => {
    const { panel } = captions({ baseline: row().replace('data-message-id="one"', "") }); const onSnapshot = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot);
    panel.querySelector("[data-tid=author]").textContent = "Carlos";
    panel.querySelector("[data-tid=closed-caption-text]").textContent = "Otra intervención";
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.lastCall[0]).toMatchObject({ speaker: "Carlos", text: "Otra intervención" });
  });

  it("does not duplicate nested Fluent caption rows", async () => {
    const { panel } = captions(); const onSnapshot = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot);
    panel.innerHTML = `<div data-tid="closed-caption-chat-message">${row().replace('data-tid="closed-caption-chat-message"', 'class="fui-ChatMessageCompact"')}</div>`;
    await Promise.resolve(); expect(onSnapshot).toHaveBeenCalledTimes(1);
    panel.replaceWith(panel.cloneNode(true)); await vi.advanceTimersByTimeAsync(500);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("revises a caption when the speaker name arrives after its text", async () => {
    const { panel } = captions(); const onSnapshot = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot);
    panel.innerHTML = row("", "Hola"); await Promise.resolve();
    const firstId = onSnapshot.mock.lastCall[0].utteranceId;
    panel.querySelector("[data-tid=author]").textContent = "Ana"; await Promise.resolve();
    expect(onSnapshot.mock.lastCall[0]).toMatchObject({ utteranceId: firstId, speaker: "Ana", revision: 2 });
  });

  it("keeps a repeated phrase with a different message ID after remount", async () => {
    const { panel } = captions(); const onSnapshot = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot);
    panel.innerHTML = row(); await Promise.resolve();
    const firstId = onSnapshot.mock.lastCall[0].utteranceId;
    const replacement = panel.cloneNode(true);
    replacement.firstElementChild.setAttribute("data-message-id", "second");
    panel.replaceWith(replacement); await vi.advanceTimersByTimeAsync(500);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.lastCall[0].utteranceId).not.toBe(firstId);
  });

  it("reconnects to a replaced panel without duplicating copied text", async () => {
    const { panel } = captions(); const onSnapshot = vi.fn();
    stop = enableTeamsCaptionsAndObserve(onSnapshot);
    panel.innerHTML = row(); await Promise.resolve();
    const replacement = panel.cloneNode(true); panel.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(500);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    replacement.querySelector("[data-tid=closed-caption-text]").textContent = "Hola otra vez";
    stop.flush();
    expect(onSnapshot.mock.lastCall[0]).toMatchObject({ revision: 2, text: "Hola otra vez" });
    stop(); replacement.innerHTML = row("Carlos", "Después");
    await vi.advanceTimersByTimeAsync(5000);
    expect(onSnapshot).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("waits when captions are unavailable and never treats the chat as captions", () => {
    vi.useFakeTimers(); document.body.innerHTML = '<div role="region">Chat history</div>';
    const onStatus = vi.fn(); stop = enableTeamsCaptionsAndObserve(vi.fn(), { onStatus });
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: "preparing", panel: false }));
  });

  it("respects trusted manual pause and resume", () => {
    const { button } = captions(); const control = createTeamsCaptionControl(); stop = () => control.dispose();
    expect(control.sync().state).toBe("active");
    control.handleUserToggle({ isTrusted: true, target: button }); button.click();
    expect(control.sync().state).toBe("paused"); expect(button.getAttribute("aria-pressed")).toBe("false");
    control.handleUserToggle({ isTrusted: true, target: button }); button.click();
    expect(control.sync().state).toBe("active");
  });

  it("opens More and Language and speech to reach captions", () => {
    vi.useFakeTimers(); document.body.innerHTML = '<button id="callingButtons-showMoreBtn">More</button>';
    document.querySelector("button").onclick = () => {
      const speech = document.createElement("button"); speech.setAttribute("role", "menuitem"); speech.textContent = "Idioma y voz";
      speech.onclick = () => {
        const cc = document.createElement("button"); cc.setAttribute("role", "menuitem"); cc.textContent = "Activar subtítulos en directo";
        cc.onclick = () => { const panel = document.createElement("div"); panel.dataset.tid = "closed-captions-renderer"; document.body.append(panel); cc.remove(); speech.remove(); };
        document.body.append(cc);
      };
      document.body.append(speech);
    };
    const control = createTeamsCaptionControl(); stop = () => control.dispose();
    expect(control.sync().state).toBe("preparing");
    control.sync(); expect(control.sync().state).toBe("active");
  });
});
