import { icon } from "../shared/icons.js";

const searchInput = document.getElementById("search-input");
const filterChipsEl = document.getElementById("filter-chips");
const calendarEl = document.getElementById("calendar");
const kpisEl = document.getElementById("kpis");
const resultsCountEl = document.getElementById("results-count");
const sortSelect = document.getElementById("sort-select");
const meetingsListEl = document.getElementById("meetings-list");
const detailPanelEl = document.getElementById("detail-panel");

document.getElementById("search-icon").innerHTML = icon("search", { size: 15, color: "var(--text-muted)" });
document.getElementById("sort-icon").innerHTML = icon("arrow-up-down", { size: 14, color: "var(--text-secondary)" });

// Se usan en el panel de detalle de la siguiente tarea. Se conservan acá para
// que ese panel pueda abrir y descargar archivos sin cambiar la estrategia.
function downloadFile(file, suggestedName) {
  const url = URL.createObjectURL(file);
  chrome.downloads.download({ url, filename: suggestedName, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError || downloadId === undefined) {
      URL.revokeObjectURL(url);
      return;
    }
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
        URL.revokeObjectURL(url);
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

function viewFile(file) {
  // El object URL permanece vivo mientras la pestaña nueva lee el archivo.
  chrome.tabs.create({ url: URL.createObjectURL(file) });
}

const state = {
  meetings: [], search: "",
  filters: { transcript: false, video: false, audioOnly: false, thisMonth: false, thisYear: false },
  calendarMonth: startOfMonth(new Date()), selectedDay: null, sort: "newest", selectedMeetingId: null, selectedTab: null,
};

const FILTERS = [["all", "Todas"], ["transcript", "Con transcripción"], ["video", "Con video"], ["audioOnly", "Solo audio"], ["thisMonth", "Este mes"], ["thisYear", "Este año"]];

function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function dayKey(date) { return new Date(date).toDateString(); }
function sameLocalDay(left, right) { return dayKey(left) === dayKey(right); }
function isInCurrentMonth(date, now = new Date()) { return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth(); }
function isInCurrentYear(date, now = new Date()) { return date.getFullYear() === now.getFullYear(); }
function titleFor(meeting) { return meeting.meetingTitle || meeting.folderName || "Reunión sin título"; }
function meetingId(meeting) { return meeting.sessionId || meeting.folderName; }
function endTime(meeting) {
  const startedAt = Number(meeting.startedAt);
  return meeting.endedAt ?? (meeting.durationMs != null ? startedAt + Number(meeting.durationMs) : startedAt);
}

export function deriveVisibleMeetings(currentState) {
  const normalizedSearch = currentState.search.trim().toLocaleLowerCase();
  const { transcript, video, audioOnly, thisMonth, thisYear } = currentState.filters;
  const now = new Date();
  const visible = currentState.meetings.filter((meeting) => {
    const startedAt = new Date(meeting.startedAt);
    if (Number.isNaN(startedAt.getTime())) return false;
    if (normalizedSearch && !titleFor(meeting).toLocaleLowerCase().includes(normalizedSearch)) return false;
    if (transcript && !meeting.hasTranscript) return false;
    if (video && !meeting.hasVideo) return false;
    if (audioOnly && meeting.hasVideo) return false;
    if (thisMonth && !isInCurrentMonth(startedAt, now)) return false;
    if (thisYear && !isInCurrentYear(startedAt, now)) return false;
    return !currentState.selectedDay || sameLocalDay(startedAt, currentState.selectedDay);
  });
  return visible.sort((left, right) => currentState.sort === "oldest" ? left.startedAt - right.startedAt : right.startedAt - left.startedAt);
}

function formatMonth(date) { return new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" }).format(date); }
function capitalize(text) { return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text; }
function formatMeetingDate(meeting) {
  const started = new Date(meeting.startedAt);
  const ended = new Date(endTime(meeting));
  const date = capitalize(new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(started).replace(".", ""));
  const time = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} · ${time.format(started)} – ${time.format(ended)}`;
}
function formatDuration(totalMs) { const totalMinutes = Math.floor(Math.max(0, totalMs) / 60000); return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`; }
function allFiltersOff() { return Object.values(state.filters).every((active) => !active); }

function renderSidebar() { renderFilters(); renderCalendar(); renderKpis(); }

function renderFilters() {
  filterChipsEl.replaceChildren();
  for (const [key, label] of FILTERS) {
    const button = document.createElement("button");
    const active = key === "all" ? allFiltersOff() : state.filters[key];
    button.type = "button"; button.className = `filter-chip${active ? " is-active" : ""}`; button.textContent = label; button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", () => {
      if (key === "all") Object.keys(state.filters).forEach((filter) => { state.filters[filter] = false; });
      else state.filters[key] = !state.filters[key];
      renderAllExceptDetail();
    });
    filterChipsEl.appendChild(button);
  }
}

function renderCalendar() {
  calendarEl.replaceChildren();
  const header = document.createElement("div"); header.className = "calendar-header";
  const heading = document.createElement("div"); heading.className = "calendar-title";
  heading.innerHTML = icon("calendar", { size: 15, color: "var(--text-secondary)" });
  const month = document.createElement("span"); month.textContent = formatMonth(state.calendarMonth); heading.appendChild(month);
  const controls = document.createElement("div"); controls.className = "calendar-controls";
  controls.append(createCalendarButton("chevron-left", "Mes anterior", -1), createCalendarButton("chevron-right", "Mes siguiente", 1));
  header.append(heading, controls); calendarEl.appendChild(header);
  const weekdays = document.createElement("div"); weekdays.className = "calendar-weekdays";
  ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"].forEach((label) => { const day = document.createElement("span"); day.textContent = label; weekdays.appendChild(day); });
  calendarEl.appendChild(weekdays);
  const days = document.createElement("div"); days.className = "calendar-days";
  const first = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth(), 1);
  const gridStart = new Date(first); gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const meetingDays = new Set(state.meetings.map((meeting) => dayKey(meeting.startedAt)));
  const today = new Date();
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart); date.setDate(gridStart.getDate() + index);
    const selected = state.selectedDay && sameLocalDay(date, state.selectedDay);
    const button = document.createElement("button"); button.type = "button";
    button.className = `calendar-day${date.getMonth() !== state.calendarMonth.getMonth() ? " is-outside" : ""}${sameLocalDay(date, today) ? " is-today" : ""}${selected ? " is-selected" : ""}`;
    button.textContent = String(date.getDate()); button.setAttribute("aria-label", new Intl.DateTimeFormat("es-ES", { dateStyle: "full" }).format(date)); button.setAttribute("aria-pressed", String(Boolean(selected)));
    if (meetingDays.has(dayKey(date))) { const dot = document.createElement("span"); dot.className = "meeting-dot"; dot.setAttribute("aria-hidden", "true"); button.appendChild(dot); }
    button.addEventListener("click", () => { state.selectedDay = selected ? null : date; renderAllExceptDetail(); });
    days.appendChild(button);
  }
  calendarEl.appendChild(days);
}

function createCalendarButton(iconName, label, offset) {
  const button = document.createElement("button"); button.type = "button"; button.className = "icon-button"; button.setAttribute("aria-label", label); button.innerHTML = icon(iconName, { size: 16, color: "var(--text-secondary)" });
  button.addEventListener("click", () => { state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + offset, 1); renderCalendar(); });
  return button;
}

function renderKpis() {
  kpisEl.replaceChildren();
  const thisMonth = state.meetings.filter((meeting) => isInCurrentMonth(new Date(meeting.startedAt)));
  const rows = [[String(thisMonth.length), "reuniones este mes"], [formatDuration(thisMonth.reduce((total, meeting) => total + (meeting.durationMs ?? 0), 0)), "de grabación"], [String(state.meetings.filter((meeting) => meeting.hasVideo).length), "reuniones con video"], [String(state.meetings.filter((meeting) => meeting.hasTranscript).length), "reuniones con transcripción"]];
  rows.forEach(([value, label]) => { const row = document.createElement("div"); row.className = "kpi-row"; const valueEl = document.createElement("strong"); valueEl.className = "kpi-value"; valueEl.textContent = value; const labelEl = document.createElement("span"); labelEl.className = "kpi-label"; labelEl.textContent = label; row.append(valueEl, labelEl); kpisEl.appendChild(row); });
}

function renderMeetings() {
  const meetings = deriveVisibleMeetings(state); resultsCountEl.textContent = `${meetings.length} resultados`; meetingsListEl.replaceChildren();
  if (!meetings.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Todavía no hay reuniones que coincidan con estos filtros."; meetingsListEl.appendChild(empty); return; }
  meetings.forEach((meeting) => meetingsListEl.appendChild(createMeetingCard(meeting)));
}

function createMeetingCard(meeting) {
  const card = document.createElement("article"); card.className = "meeting-card";
  const header = document.createElement("div"); header.className = "meeting-card-header";
  const title = document.createElement("h3"); title.className = "meeting-title"; title.textContent = titleFor(meeting);
  const more = document.createElement("span"); more.className = "more-icon"; more.setAttribute("aria-hidden", "true"); more.innerHTML = icon("ellipsis", { size: 17, color: "var(--text-secondary)" }); header.append(title, more);
  const date = document.createElement("p"); date.className = "meeting-date"; date.textContent = formatMeetingDate(meeting);
  const chips = document.createElement("div"); chips.className = "file-chips";
  [[meeting.hasTranscript, "Transcripción"], [true, "Audio"], [meeting.hasVideo, "Video"], [true, "Manifest"]].filter(([available]) => available).forEach(([, label]) => { const chip = document.createElement("span"); chip.className = "file-chip"; chip.textContent = label; chips.appendChild(chip); });
  const details = document.createElement("button"); details.type = "button"; details.className = "details-button"; details.textContent = "Ver detalles"; details.addEventListener("click", () => { state.selectedMeetingId = meetingId(meeting); state.selectedTab = null; renderDetail(); });
  card.append(header, date, chips, details); return card;
}

function renderDetail() {
  detailPanelEl.replaceChildren(); const placeholder = document.createElement("p"); placeholder.className = "detail-placeholder";
  placeholder.textContent = state.selectedMeetingId ? "Detalle de reunión disponible próximamente." : "Seleccioná una reunión para ver el detalle";
  detailPanelEl.appendChild(placeholder);
}
function renderAllExceptDetail() { renderSidebar(); renderMeetings(); }

searchInput.addEventListener("input", () => { state.search = searchInput.value; renderAllExceptDetail(); });
sortSelect.addEventListener("change", () => { state.sort = sortSelect.value; renderMeetings(); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.meetingHistory) return;
  state.meetings = Array.isArray(changes.meetingHistory.newValue) ? changes.meetingHistory.newValue : [];
  if (state.selectedMeetingId && !state.meetings.some((meeting) => meetingId(meeting) === state.selectedMeetingId)) state.selectedMeetingId = null;
  renderAllExceptDetail(); renderDetail();
});
chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => { state.meetings = Array.isArray(meetingHistory) ? meetingHistory : []; renderAllExceptDetail(); renderDetail(); });
