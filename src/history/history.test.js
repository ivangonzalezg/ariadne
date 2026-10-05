import { describe, expect, it, vi } from "vitest";

document.body.innerHTML = `
  <aside class="sidebar" aria-label="Filtros del historial">
    <div class="brand"><img alt="" /><span>Ariadne</span></div>
    <div><h1 id="page-heading" class="sidebar-heading">Historial</h1><p id="page-description" class="sidebar-description"></p></div>
    <div class="search-field"><span id="search-icon" class="search-icon" aria-hidden="true"></span><input id="search-input" type="search" /></div>
    <section aria-labelledby="filters-label" hidden><span id="filters-label" class="section-label"></span><div id="filter-chips" class="filter-chips"></div></section>
    <section class="calendar" aria-label="Calendario"><div id="calendar"></div></section>
    <section aria-labelledby="kpis-label"><span id="kpis-label" class="section-label"></span><div id="kpis" class="kpis"></div></section>
  </aside>
  <section class="meetings-panel" aria-labelledby="meetings-title">
    <header class="meetings-header"><div><h2 id="meetings-title" class="meetings-title"></h2><p id="results-count" class="results-count"></p></div><label class="sort-control"><select id="sort-select"><option value="newest">Newest</option><option value="oldest">Oldest</option></select><span id="sort-chevron" class="sort-chevron" aria-hidden="true"></span></label></header>
    <div id="meetings-list" class="meetings-list" aria-live="polite"></div>
  </section>
  <section id="detail-panel" class="detail-panel" aria-label="Detalle de reunión"></section>
`;

let historyChanged;
globalThis.chrome = {
  runtime: { getURL: (path) => path },
  storage: {
    local: {
      get: (defaults, callback) => callback(defaults),
      set: () => {},
    },
    onChanged: { addListener: listener => { historyChanged = listener; } },
  },
  tabs: { create: () => {}, sendMessage: () => {} },
  downloads: { download: () => {}, onChanged: { addListener: () => {}, removeListener: () => {} } },
};
globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));

const { deriveVisibleMeetings } = await import("./history.js");

function meeting(overrides) {
  return {
    sessionId: "s1",
    folderName: "folder-1",
    meetingTitle: "Weekly sync",
    startedAt: new Date("2026-01-05T10:00:00Z").getTime(),
    hasTranscript: true,
    hasVideo: false,
    ...overrides,
  };
}

describe("deriveVisibleMeetings", () => {
  it("filters by search text (case/locale-insensitive)", () => {
    const state = { meetings: [meeting({ meetingTitle: "Café con equipo" })], search: "CAFÉ", filters: {}, sort: "newest", selectedDay: null };
    expect(deriveVisibleMeetings(state)).toHaveLength(1);
  });

  it("excludes meetings without a transcript when the transcript filter is on", () => {
    const state = { meetings: [meeting({ hasTranscript: false })], search: "", filters: { transcript: true }, sort: "newest", selectedDay: null };
    expect(deriveVisibleMeetings(state)).toHaveLength(0);
  });

  it("sorts oldest first when requested", () => {
    const older = meeting({ sessionId: "old", startedAt: new Date("2026-01-01T00:00:00Z").getTime() });
    const newer = meeting({ sessionId: "new", startedAt: new Date("2026-01-10T00:00:00Z").getTime() });
    const state = { meetings: [newer, older], search: "", filters: {}, sort: "oldest", selectedDay: null };
    expect(deriveVisibleMeetings(state).map((m) => m.sessionId)).toEqual(["old", "new"]);
  });
});

it("renders recovery states, deduplicates retry, and preserves content on progress updates", async () => {
  const { MemoryDirectoryHandle } = await import("../../tests/helpers/memory-opfs.js");
  const root = new MemoryDirectoryHandle("root");
  const folder = await root.getDirectoryHandle("recovery-folder", { create: true });
  const file = await folder.getFileHandle("transcripcion.json", { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify([{ index: 0, startTime: 0, endTime: 1, text: "Saved", speaker: "Ana" }])); await writable.close();
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
  const entry = meeting({ folderName: "recovery-folder", recordingStatus: "incomplete", audioConversionStatus: "pending",
    transcriptExportStatus: "succeeded", processing: { supported: true, pending: true, canRetry: false, tasks: [] } });
  chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ ...entry, recovery: entry.processing });
  historyChanged({ meetingHistory: { newValue: [entry] } }, "local");
  document.querySelector(".meeting-card").click();
  await vi.waitFor(() => expect(document.querySelector(".transcript-list")).toBeTruthy());
  const content = document.querySelector(".transcript-list");
  const button = document.querySelector(".recovery-retry");
  expect(button.disabled).toBe(true);
  expect(document.querySelector(".recovery-message").getAttribute("role")).toBe("status");
  const failed = { ...entry, audioConversionStatus: "failed", processing: { supported: true, pending: false, canRetry: true, tasks: [{ stream: "meeting", state: "failed", error: "INPUT_INVALID" }] } };
  chrome.runtime.sendMessage.mockResolvedValue({ ...failed, recovery: failed.processing });
  historyChanged({ meetingHistory: { newValue: [failed] } }, "local");
  expect(document.querySelector(".transcript-list")).toBe(content);
  expect(document.querySelector(".recovery-retry")).toBe(button);
  expect(button.disabled).toBe(false);
  button.click(); button.click();
  await vi.waitFor(() => expect(chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === "asterion:retry-recovery")).toHaveLength(1));
});

it("uses understandable quota and unrecoverable-data errors", async () => {
  const { recoveryErrorMessage } = await import("./history.js");
  expect(recoveryErrorMessage("QuotaExceededError")).toBe("history.recoveryQuotaError");
  expect(recoveryErrorMessage("INPUT_INVALID: no continuous saved prefix")).toBe("history.recoveryNoData");
});
