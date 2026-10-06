// src/history/history.js
import { icon } from "../shared/icons.js";
import { formatSegmentTimestamp, transcriptToTxt, transcriptToMarkdown } from "../lib/transcript-export.js";
import { initI18n } from "../shared/i18n/i18n.js";

const { t, localeTag } = await initI18n();
document.title = t("history.pageTitle");

const searchInput = document.getElementById("search-input");
const filterChipsEl = document.getElementById("filter-chips");
const calendarEl = document.getElementById("calendar");
const kpisEl = document.getElementById("kpis");
const resultsCountEl = document.getElementById("results-count");
const sortSelect = document.getElementById("sort-select");
const meetingsListEl = document.getElementById("meetings-list");
const detailPanelEl = document.getElementById("detail-panel");
let detailSession = null;
let nextDetailId = 0;
let detailShell, meetingRegion, meetingFooter, deleteMeetingButton, meetingAnimation;
let openMoreMenu = null;
const pendingDeletes = new Set();

document.getElementById("page-heading").textContent = t("history.pageHeading");
document.getElementById("page-description").textContent = t("history.pageDescription");
document.querySelector(".sidebar").setAttribute("aria-label", t("history.filtersAsideAria"));
searchInput.placeholder = t("history.searchPlaceholder");
searchInput.setAttribute("aria-label", t("history.searchPlaceholder"));
document.getElementById("filters-label").textContent = t("history.filtersLabel");
document.querySelector(".calendar").setAttribute("aria-label", t("history.calendarAria"));
document.getElementById("kpis-label").textContent = t("history.summaryLabel");
document.getElementById("meetings-title").textContent = t("history.meetingsTitle");
sortSelect.setAttribute("aria-label", t("history.sortAria"));
sortSelect.querySelector('option[value="newest"]').textContent = t("history.sortNewest");
sortSelect.querySelector('option[value="oldest"]').textContent = t("history.sortOldest");
detailPanelEl.setAttribute("aria-label", t("history.detailPanelAria"));

document.getElementById("search-icon").innerHTML = icon("search", { size: 15, color: "var(--text-muted)" });
document.getElementById("sort-chevron").innerHTML = icon("chevron-down", { size: 12, color: "var(--text-muted)" });

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
  chrome.tabs.create({ url: URL.createObjectURL(file) });
}

const state = {
  meetings: [], search: "",
  filters: { transcript: false, video: false, audioOnly: false, thisMonth: false, thisYear: false },
  calendarMonth: startOfMonth(new Date()), selectedDay: null, sort: "newest", selectedMeetingId: null, selectedTab: null,
};

const FILTERS = () => [["all", t("history.filterAll")], ["transcript", t("history.filterTranscript")], ["video", t("history.filterVideo")], ["audioOnly", t("history.filterAudioOnly")], ["thisMonth", t("history.filterThisMonth")], ["thisYear", t("history.filterThisYear")]];

function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function dayKey(date) { return new Date(date).toDateString(); }
function sameLocalDay(left, right) { return dayKey(left) === dayKey(right); }
function isInCurrentMonth(date, now = new Date()) { return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth(); }
function isInCurrentYear(date, now = new Date()) { return date.getFullYear() === now.getFullYear(); }
function titleFor(meeting) { return meeting.meetingTitle || meeting.folderName || t("common.untitledMeeting"); }
function meetingId(meeting) { return meeting.sessionId || meeting.folderName; }
function endTime(meeting) {
  const startedAt = Number(meeting.startedAt);
  return meeting.endedAt ?? (meeting.durationMs != null ? startedAt + Number(meeting.durationMs) : startedAt);
}
function durationOf(meeting) {
  if (meeting.durationMs != null) return Number(meeting.durationMs);
  if (meeting.endedAt != null) return Number(meeting.endedAt) - Number(meeting.startedAt);
  return 0;
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

function formatMonth(date) { return `${capitalize(new Intl.DateTimeFormat(localeTag, { month: "long" }).format(date))} ${date.getFullYear()}`; }
function capitalize(text) { return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text; }
function weekdayShortLabels() {
  const formatter = new Intl.DateTimeFormat(localeTag, { weekday: "short" });
  // 2024-01-01 is a Monday; formatting Mon..Sun from a fixed reference week
  // keeps this independent of the calendar actually being rendered.
  return Array.from({ length: 7 }, (_, index) => capitalize(formatter.format(new Date(2024, 0, 1 + index)).replace(".", "")));
}
function formatMeetingDate(meeting) {
  const started = new Date(meeting.startedAt);
  const ended = new Date(endTime(meeting));
  const date = capitalize(new Intl.DateTimeFormat(localeTag, { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(started).replace(".", ""));
  const time = new Intl.DateTimeFormat(localeTag, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} · ${time.format(started)} – ${time.format(ended)}`;
}
function formatDetailDate(meeting) { return capitalize(new Intl.DateTimeFormat(localeTag, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(meeting.startedAt))); }
function formatTimeRange(meeting) { const formatter = new Intl.DateTimeFormat(localeTag, { hour: "2-digit", minute: "2-digit", hour12: false }); return `${formatter.format(new Date(meeting.startedAt))} – ${formatter.format(new Date(endTime(meeting)))}`; }
function formatDurationHours(totalMs) { const hours = Math.ceil((Math.max(0, totalMs) / 3600000) * 10) / 10; return `${hours} h`; }
function formatMediaTime(seconds) { if (!Number.isFinite(seconds) || seconds < 0) return "0:00"; const totalSeconds = Math.floor(seconds); return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`; }
function formatFileSize(bytes) { if (!Number.isFinite(bytes)) return ""; const units = ["B", "KB", "MB", "GB"]; let value = bytes; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; } return `${value.toLocaleString(localeTag, { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`; }
function allFiltersOff() { return Object.values(state.filters).every((active) => !active); }

function renderSidebar() { renderFilters(); renderCalendar(); renderKpis(); }

function renderFilters() {
  filterChipsEl.replaceChildren();
  for (const [key, label] of FILTERS()) {
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
  const month = document.createElement("span"); month.textContent = formatMonth(state.calendarMonth); heading.appendChild(month);
  const controls = document.createElement("div"); controls.className = "calendar-controls";
  controls.append(createCalendarButton("chevron-left", t("history.prevMonthAria"), -1), createCalendarButton("chevron-right", t("history.nextMonthAria"), 1));
  header.append(heading, controls); calendarEl.appendChild(header);
  const weekdays = document.createElement("div"); weekdays.className = "calendar-weekdays";
  weekdayShortLabels().forEach((label) => { const day = document.createElement("span"); day.textContent = label; weekdays.appendChild(day); });
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
    button.textContent = String(date.getDate()); button.setAttribute("aria-label", new Intl.DateTimeFormat(localeTag, { dateStyle: "full" }).format(date)); button.setAttribute("aria-pressed", String(Boolean(selected)));
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
  const rows = [[String(thisMonth.length), t("history.kpiMeetingsThisMonth")], [formatDurationHours(thisMonth.reduce((total, meeting) => total + durationOf(meeting), 0)), t("history.kpiRecordingHours")], [String(state.meetings.filter((meeting) => meeting.hasVideo).length), t("history.kpiMeetingsWithVideo")], [String(state.meetings.filter((meeting) => meeting.hasTranscript).length), t("history.kpiMeetingsWithTranscript")]];
  rows.forEach(([value, label]) => { const row = document.createElement("div"); row.className = "kpi-row"; const valueEl = document.createElement("strong"); valueEl.className = "kpi-value"; valueEl.textContent = value; const labelEl = document.createElement("span"); labelEl.className = "kpi-label"; labelEl.textContent = label; row.append(valueEl, labelEl); kpisEl.appendChild(row); });
}

function renderMeetings() {
  closeOpenMoreMenu(false, true);
  const meetings = deriveVisibleMeetings(state); resultsCountEl.textContent = t("history.resultsCount", { count: meetings.length }); meetingsListEl.replaceChildren();
  if (!meetings.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = t("history.emptyState"); meetingsListEl.appendChild(empty); return; }
  meetings.forEach((meeting) => meetingsListEl.appendChild(createMeetingCard(meeting)));
}

function closeOpenMoreMenu(restoreFocus = false, immediate = false) {
  if (!openMoreMenu) return;
  const { menu, button } = openMoreMenu; openMoreMenu = null;
  button.classList.remove("is-open"); button.setAttribute("aria-expanded", "false");
  menu.inert = true;
  if (restoreFocus && button.isConnected) button.focus();
  if (!immediate && menu.animate) {
    menu.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }).finished.then(() => menu.remove(), () => menu.remove());
  } else menu.remove();
}
document.addEventListener("click", event => {
  if (openMoreMenu && !openMoreMenu.menu.contains(event.target) && event.target !== openMoreMenu.button) closeOpenMoreMenu();
});
function openMeetingDetail(meeting, tab, event) {
  if (state.selectedMeetingId !== meetingId(meeting)) state.selectedTab = null;
  state.selectedMeetingId = meetingId(meeting);
  if (tab) state.selectedTab = tab;
  for (const card of meetingsListEl.querySelectorAll(".meeting-card")) card.classList.toggle("is-selected", card.dataset.meetingId === state.selectedMeetingId);
  renderDetail(Boolean(event?.detail));
  if (tab && detailSession?.pages.has(tab)) selectPage(detailSession, tab, !event?.detail);
}

function createMeetingCard(meeting) {
  const card = document.createElement("article"); card.className = `meeting-card${meetingId(meeting) === state.selectedMeetingId ? " is-selected" : ""}`;
  card.dataset.meetingId = meetingId(meeting);
  card.addEventListener("click", event => openMeetingDetail(meeting, null, event));
  const header = document.createElement("div"); header.className = "meeting-card-header";
  const title = document.createElement("h3"); title.className = "meeting-title"; title.textContent = titleFor(meeting);
  const moreWrap = document.createElement("div"); moreWrap.className = "more-wrap";
  const more = document.createElement("button"); more.type = "button"; more.className = "more-button"; more.setAttribute("aria-label", t("history.moreOptionsAria")); more.setAttribute("aria-haspopup", "true"); more.setAttribute("aria-expanded", "false"); more.innerHTML = icon("ellipsis", { size: 17, color: "currentColor" });
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasOpen = more.classList.contains("is-open");
    closeOpenMoreMenu(false, true);
    if (wasOpen) return;
    more.classList.add("is-open"); more.setAttribute("aria-expanded", "true");
    const menu = document.createElement("div"); menu.className = "more-menu"; menu.setAttribute("role", "menu");
    const deleteItem = document.createElement("button"); deleteItem.type = "button"; deleteItem.className = "more-menu-item"; deleteItem.setAttribute("role", "menuitem");
    deleteItem.innerHTML = icon("trash-2", { size: 14, color: "currentColor" });
    deleteItem.appendChild(document.createTextNode(t("common.deleteMeeting")));
    deleteItem.addEventListener("click", (deleteEvent) => { deleteEvent.stopPropagation(); closeOpenMoreMenu(false, true); showDeleteDialog(meeting, more); });
    menu.appendChild(deleteItem);
    moreWrap.appendChild(menu);
    openMoreMenu = { menu, button: more };
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeOpenMoreMenu(true, true); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); deleteItem.focus(); }
      if (event.key === "Tab") closeOpenMoreMenu(true, true);
    });
    if (event.detail && menu.animate && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) menu.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "scale(1)" }], { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    deleteItem.focus();
  });
  more.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (!more.classList.contains("is-open")) more.click(); }
  });
  moreWrap.appendChild(more);
  header.append(title, moreWrap);
  const date = document.createElement("p"); date.className = "meeting-date"; date.textContent = formatMeetingDate(meeting);
  const chips = document.createElement("div"); chips.className = "file-chips";
  [[meeting.hasTranscript, "file-text", t("common.transcript"), "transcript"], [true, "volume-2", t("common.audio"), "audio"], [meeting.hasVideo, "video", t("common.video"), "video"], [true, "braces", t("common.manifest"), "manifest"]].forEach(([available, iconName, label, tab]) => {
    const chip = document.createElement(available ? "button" : "span"); if (available) chip.type = "button"; chip.className = `file-chip${available ? " is-available" : " is-unavailable"}`;
    chip.innerHTML = icon(iconName, { size: 12, color: "currentColor" });
    chip.appendChild(document.createTextNode(label));
    if (available) { chip.addEventListener("click", (event) => { event.stopPropagation(); openMeetingDetail(meeting, tab, event); }); }
    chips.appendChild(chip);
  });
  const detailsRow = document.createElement("div"); detailsRow.className = "details-row";
  const details = document.createElement("button"); details.type = "button"; details.className = "details-button"; details.textContent = t("history.viewDetails");
  detailsRow.appendChild(details);
  card.append(header, date, chips, detailsRow); return card;
}

function availableTabs(meeting) { return [[meeting.hasTranscript, "transcript", t("common.transcript")], [true, "audio", t("common.audio")], [meeting.hasVideo, "video", t("common.video")], [true, "manifest", t("common.manifest")]].filter(([available]) => available); }
function escapeHtml(value) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function highlightJson(value) {
  const escaped = escapeHtml(JSON.stringify(value, null, 2));
  return escaped.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, (token, string, colon, literal) => {
    const className = string ? (colon ? "json-key" : "json-string") : (literal ? "json-literal" : "json-number");
    return `<span class="${className}">${token}</span>`;
  });
}
async function openMeetingDirectory(meeting) { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(meeting.folderName); }
async function readJsonFile(directory) { const file = await (await directory.getFileHandle("manifest.json")).getFile(); return { file, value: JSON.parse(await file.text()) }; }
async function readActiveFile(meeting, tab) {
  const directory = await openMeetingDirectory(meeting);
  if (tab === "transcript") { const file = await (await directory.getFileHandle("transcripcion.json")).getFile(); return { file, name: "transcripcion.json", value: JSON.parse(await file.text()) }; }
  if (tab === "manifest") { const { file, value } = await readJsonFile(directory); return { file, name: "manifest.json", value }; }
  const preferred = tab === "video" ? "video-reunion.mp4" : "audio-reunion.mp3";
  const fallback = tab === "video" ? "video-reunion.webm" : "audio-reunion.webm";
  try {
    const file = await (await directory.getFileHandle(preferred)).getFile();
    if (!file.size) throw new Error("Empty media file");
    return { file, name: preferred };
  } catch { return { file: await (await directory.getFileHandle(fallback)).getFile(), name: fallback }; }
}
function createFileFooter(activeFile, meeting, tab) {
  const footer = document.createElement("footer"); footer.className = "detail-footer";
  const fileRow = document.createElement("div"); fileRow.className = "detail-file-row";
  const metadata = document.createElement("div"); metadata.className = "detail-file-meta"; const name = document.createElement("span"); name.className = "detail-file-name"; name.textContent = activeFile.name; const size = document.createElement("span"); size.className = "detail-file-size"; size.textContent = formatFileSize(activeFile.file.size); metadata.append(name, size);
  const actions = document.createElement("div"); actions.className = "detail-file-actions";
  const view = document.createElement("button"); view.type = "button"; view.className = "detail-action"; view.innerHTML = `${icon("external-link", { size: 12, color: "currentColor" })}<span>${t("common.open")}</span>`; view.addEventListener("click", () => viewFile(activeFile.file));
  const download = document.createElement("button"); download.type = "button"; download.className = "detail-action"; download.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>${t("common.download")}</span>`; download.addEventListener("click", () => downloadFile(activeFile.file, activeFile.name));
  actions.append(view, download);
  if (tab === "transcript") {
    const downloadTxt = document.createElement("button"); downloadTxt.type = "button"; downloadTxt.className = "detail-action"; downloadTxt.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>${t("history.downloadTxt")}</span>`;
    downloadTxt.addEventListener("click", () => downloadFile(new Blob([transcriptToTxt(activeFile.value)], { type: "text/plain" }), "transcripcion.txt"));
    const downloadMd = document.createElement("button"); downloadMd.type = "button"; downloadMd.className = "detail-action"; downloadMd.innerHTML = `${icon("download", { size: 12, color: "currentColor" })}<span>${t("history.downloadMarkdown")}</span>`;
    downloadMd.addEventListener("click", () => downloadFile(new Blob([transcriptToMarkdown(activeFile.value, titleFor(meeting))], { type: "text/markdown" }), "transcripcion.md"));
    actions.append(downloadTxt, downloadMd);
  }
  fileRow.append(metadata, actions); footer.append(fileRow); return footer;
}
function disposePage(page) {
  if (page.media) { page.media.pause(); page.media.removeAttribute("src"); page.media.load(); }
  if (page.url) URL.revokeObjectURL(page.url);
  page.media = null; page.url = null;
}
function closeDetailSession() {
  clearTimeout(recoveryPoll);
  if (!detailSession) return;
  meetingAnimation?.cancel();
  detailSession.closed = true;
  for (const page of detailSession.pages.values()) disposePage(page);
  detailSession = null;
}
function createMediaButton(className, label, iconName, size = 18) {
  const button = document.createElement("button"); button.type = "button"; button.className = className; button.setAttribute("aria-label", label); button.title = label; button.innerHTML = icon(iconName, { size, color: "currentColor" }); return button;
}
function setRangeProgress(range, value, max) { range.style.setProperty("--range-progress", `${max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0}%`); }
function createMediaPlayer(activeFile, isVideo, session, page) {
  const player = document.createElement("div"); player.className = `custom-media-player${isVideo ? " custom-video-player" : " custom-audio-player"}`;
  const media = document.createElement(isVideo ? "video" : "audio"); media.className = isVideo ? "custom-video-element" : "custom-audio-element"; media.preload = "metadata"; media.controls = false;
  const sourceUrl = URL.createObjectURL(activeFile.file); page.media = media; page.url = sourceUrl;
  const seek = document.createElement("input"); seek.type = "range"; seek.className = "media-seek"; seek.min = "0"; seek.max = "0"; seek.value = "0"; seek.step = "0.1"; seek.disabled = true; seek.setAttribute("aria-label", t("history.seekAria"));
  const time = document.createElement("span"); time.className = "media-time";
  const volume = document.createElement("input"); volume.type = "range"; volume.className = "media-volume"; volume.min = "0"; volume.max = "1"; volume.value = "1"; volume.step = "0.05"; volume.setAttribute("aria-label", t("common.volumeAria")); setRangeProgress(volume, 1, 1);
  const play = createMediaButton("media-play", t("common.play"), "play", isVideo ? 18 : 20);
  const update = () => { const duration = Number.isFinite(media.duration) ? media.duration : 0; seek.max = String(duration); seek.disabled = duration <= 0; seek.value = String(Math.min(media.currentTime || 0, duration)); setRangeProgress(seek, Number(seek.value), duration); time.textContent = `${formatMediaTime(media.currentTime)} / ${formatMediaTime(duration)}`; };
  const updatePlayButton = () => { const paused = media.paused || media.ended; play.setAttribute("aria-label", paused ? t("common.play") : t("common.pause")); play.title = paused ? t("common.play") : t("common.pause"); play.innerHTML = icon(paused ? "play" : "pause", { size: isVideo ? 18 : 20, color: "currentColor" }); player.classList.toggle("is-playing", !paused); };
  const togglePlayback = async () => {
    if (media.paused || media.ended) {
      const previousIntent = session.playIntent;
      const intent = { media }; session.playIntent = intent;
      try {
        await media.play();
        if (session.closed || session.playIntent !== intent) {
          if (session.closed || (session.playIntent?.media !== media && session.playingMedia !== media)) media.pause();
        }
      } catch {
        if (session.playIntent === intent) session.playIntent = previousIntent;
        updatePlayButton();
      }
    } else {
      session.playIntent = null;
      media.pause();
    }
  };
  media.addEventListener("playing", () => {
    if (session.closed || page.media !== media || session.pages.get(page.key) !== page) { media.pause(); return; }
    if (session.playIntent?.media !== media) {
      if (session.playingMedia !== media) media.pause();
      return;
    }
    session.playingMedia = media;
    for (const other of session.pages.values()) if (other.media && other.media !== media) other.media.pause();
    updatePlaybackStatus(session);
  });
  const stopped = () => {
    if (session.playingMedia === media) session.playingMedia = null;
    updatePlaybackStatus(session);
  };
  media.addEventListener("pause", stopped); media.addEventListener("ended", stopped); media.addEventListener("error", stopped);
  media.addEventListener("volumechange", () => { volume.value = String(media.volume); setRangeProgress(volume, media.volume, 1); });
  play.addEventListener("click", togglePlayback); seek.addEventListener("input", () => { if (!seek.disabled) media.currentTime = Number(seek.value); update(); }); volume.addEventListener("input", () => { media.volume = Number(volume.value); setRangeProgress(volume, media.volume, 1); });
  media.addEventListener("loadedmetadata", update); media.addEventListener("durationchange", update); media.addEventListener("timeupdate", update); media.addEventListener("play", updatePlayButton); media.addEventListener("pause", updatePlayButton); media.addEventListener("ended", () => { update(); updatePlayButton(); }); media.addEventListener("error", () => { const error = document.createElement("p"); error.className = "media-error"; error.textContent = t("history.mediaLoadError"); player.appendChild(error); });
  if (isVideo) {
    const controls = document.createElement("div"); controls.className = "video-controls"; const volumeWrap = document.createElement("label"); volumeWrap.className = "media-volume-control"; volumeWrap.setAttribute("aria-label", t("common.volumeAria")); volumeWrap.innerHTML = icon("volume-2", { size: 17, color: "currentColor" }); volumeWrap.appendChild(volume);
    const fullscreen = createMediaButton("media-control-button", t("history.fullscreenAria"), "maximize", 17); fullscreen.addEventListener("click", () => { media.requestFullscreen().catch(() => {}); });
    const largePlay = createMediaButton("video-large-play", t("history.playVideoAria"), "play", 28); largePlay.addEventListener("click", togglePlayback); controls.append(play, seek, time, volumeWrap, fullscreen); player.append(media, largePlay, controls);
  } else {
    const label = document.createElement("p"); label.className = "audio-player-label"; label.textContent = t("common.meetingAudioLabel");
    const transport = document.createElement("div"); transport.className = "audio-transport"; const rewind = createMediaButton("media-round-button", t("history.rewind10Aria"), "rotate-ccw", 16); rewind.addEventListener("click", () => { media.currentTime = Math.max(0, media.currentTime - 10); }); const forward = createMediaButton("media-round-button", t("history.forward10Aria"), "rotate-cw", 16); forward.addEventListener("click", () => { media.currentTime = Math.min(Number.isFinite(media.duration) ? media.duration : media.currentTime + 10, media.currentTime + 10); }); transport.append(rewind, play, forward, time);
    const volumeWrap = document.createElement("label"); volumeWrap.className = "media-volume-control"; volumeWrap.setAttribute("aria-label", t("common.volumeAria")); volumeWrap.innerHTML = icon("volume-2", { size: 16, color: "var(--text-secondary)" }); volumeWrap.appendChild(volume);
    const speedWrap = document.createElement("label"); speedWrap.className = "media-speed-control";
    const speedLabel = document.createElement("span"); speedLabel.textContent = t("history.playbackSpeed");
    const speed = document.createElement("select"); speed.className = "media-speed";
    [1, 1.5, 2].forEach((rate) => {
      const option = document.createElement("option"); option.value = String(rate); option.textContent = `${rate}×`; speed.appendChild(option);
    });
    speed.value = "1";
    speed.addEventListener("change", () => { media.playbackRate = Number(speed.value); });
    media.addEventListener("ratechange", () => { speed.value = String(media.playbackRate); });
    speedWrap.append(speedLabel, speed);
    const settings = document.createElement("div"); settings.className = "audio-player-settings"; settings.append(volumeWrap, speedWrap);
    player.append(label, media, transport, seek, settings);
  }
  media.src = sourceUrl; update(); return player;
}
function renderTabContent(content, activeFile, tab, session, page) {
  if (tab === "transcript") {
    const list = document.createElement("div"); list.className = "transcript-list";
    activeFile.value.forEach((segment) => { const row = document.createElement("div"); row.className = "transcript-row"; const timestamp = document.createElement("time"); timestamp.className = "transcript-time"; timestamp.textContent = formatSegmentTimestamp(segment.startTime); const spoken = document.createElement("p"); spoken.className = "transcript-spoken"; const speaker = document.createElement("strong"); speaker.textContent = segment.speaker; spoken.append(speaker, document.createTextNode(` ${segment.text}`)); row.append(timestamp, spoken); list.appendChild(row); });
    if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "detail-empty"; empty.textContent = t("history.noTranscriptSegments"); content.appendChild(empty); } else content.appendChild(list);
  } else if (tab === "manifest") { const code = document.createElement("pre"); code.className = "manifest-code"; code.innerHTML = highlightJson(activeFile.value); content.appendChild(code); }
  else content.appendChild(createMediaPlayer(activeFile, tab === "video", session, page));
}
let recoveryPoll = null;
const recoveryRequests = new Set();

export function recoveryErrorMessage(error) {
  if (/QuotaExceeded|quota|Full/i.test(error ?? "")) return t("history.recoveryQuotaError");
  if (/INPUT_INVALID|continuous saved prefix|No recoverable transcript/i.test(error ?? "")) return t("history.recoveryNoData");
  return t("history.recoveryTaskError");
}

function createRecoveryPanel(meeting) {
  const panel = document.createElement("section"); panel.className = "recovery-panel";
  panel.setAttribute("aria-label", t("history.recoveryTitle"));
  panel.hidden = true;
  const message = document.createElement("p"); message.className = "recovery-message";
  message.setAttribute("role", "status"); message.setAttribute("aria-atomic", "true");
  const retry = document.createElement("button"); retry.type = "button"; retry.className = "recovery-retry";
  retry.textContent = t("history.retryPending"); retry.hidden = true;
  panel.append(message, retry);
  const apply = result => {
    const recovery = result.recovery ?? result.processing;
    const error = recovery?.tasks?.find(task => task.error && task.state === "failed")?.error;
    panel.hidden = !recovery?.supported || !(recovery.pending || recovery.canRetry || error);
    message.textContent = error ? recoveryErrorMessage(error) : recovery?.pending ? t("history.recoveryInProgress") : recovery?.canRetry ? t("history.recoveryTaskError") : "";
    retry.hidden = !recovery?.canRetry;
    retry.disabled = recovery?.pending || recoveryRequests.has(meeting.sessionId);
    retry.textContent = t(retry.disabled ? "history.recoveryInProgress" : "history.retryPending");
    return recovery?.pending;
  };
  const refresh = async () => {
    if (!panel.isConnected) return;
    clearTimeout(recoveryPoll);
    try {
      const result = await chrome.runtime.sendMessage({ type: "asterion:get-recovery-status", sessionId: meeting.sessionId, folderName: meeting.folderName });
      if (!panel.isConnected) return;
      if (!result) throw new Error("Unavailable");
      const pending = apply(result);
      if (pending) recoveryPoll = setTimeout(refresh, 2000);
    } catch {
      if (panel.isConnected && !panel.hidden) recoveryPoll = setTimeout(refresh, 2000);
    }
  };
  retry.addEventListener("click", async () => {
    if (recoveryRequests.has(meeting.sessionId)) return;
    recoveryRequests.add(meeting.sessionId); retry.disabled = true; retry.textContent = t("history.recoveryInProgress");
    try {
      const result = await chrome.runtime.sendMessage({ type: "asterion:retry-recovery", sessionId: meeting.sessionId, folderName: meeting.folderName });
      if (!result || result.error) throw new Error(result?.error);
      if (panel.isConnected) apply(result);
    } catch { if (panel.isConnected) message.textContent = t("history.recoveryTaskError"); }
    finally { recoveryRequests.delete(meeting.sessionId); await refresh(); }
  });
  panel.addEventListener("asterion:recovery-update", event => {
    clearTimeout(recoveryPoll);
    if (apply(event.detail)) recoveryPoll = setTimeout(refresh, 2000);
  });
  apply(meeting);
  queueMicrotask(refresh);
  return panel;
}

function fileRevision(meeting, key) {
  if (key === "audio") return String(Boolean(meeting.hasAudioMp3));
  if (key === "video") return String(Boolean(meeting.hasVideoMp4));
  if (key === "transcript") return `${meeting.hasTranscript}:${meeting.transcriptExportStatus}`;
  return JSON.stringify([meeting.transcriptExportStatus, meeting.audioConversionStatus, meeting.videoConversionStatus, meeting.recordingStatus]);
}
function loadPage(session, page) {
  if (page.pending || (page.file && !page.dirty)) return page.pending;
  if (page.media && !page.media.paused) return;
  const revision = page.revision;
  page.pending = (async () => {
    try {
      const file = await readActiveFile(session.meeting, page.key);
      if (session.closed || session.pages.get(page.key) !== page) return;
      if (page.media && !page.media.paused) { page.dirty = true; return; }
      const position = page.content.scrollTop;
      const playback = page.media && { time: page.media.currentTime, volume: page.media.volume, rate: page.media.playbackRate };
      disposePage(page);
      page.content.replaceChildren(); page.footer?.remove();
      page.file = file;
      renderTabContent(page.content, file, page.key, session, page);
      page.footer = createFileFooter(file, session.meeting, page.key);
      page.panel.appendChild(page.footer);
      page.content.scrollTop = position;
      if (playback && page.media) {
        page.media.volume = playback.volume; page.media.playbackRate = playback.rate;
        const media = page.media;
        media.addEventListener("loadedmetadata", () => {
          media.currentTime = Math.min(playback.time, Number.isFinite(media.duration) ? media.duration : playback.time);
        }, { once: true });
      }
      page.dirty = page.revision !== revision;
    } catch {
      if (session.closed || session.pages.get(page.key) !== page) return;
      if (!page.file) {
        const unavailable = document.createElement("p"); unavailable.className = "detail-empty";
        unavailable.textContent = t("history.fileOpenError"); page.content.replaceChildren(unavailable);
      }
      page.dirty = false;
    } finally {
      page.pending = null;
      if (!session.closed && session.pages.get(page.key) === page && page.dirty && state.selectedTab === page.key && (!page.media || page.media.paused)) loadPage(session, page);
    }
  })();
  return page.pending;
}
function selectPage(session, key, immediate = false, visit = true) {
  state.selectedTab = key;
  const pages = [...session.pages.values()];
  for (const page of pages) {
    const active = page.key === key;
    page.tab.classList.toggle("is-active", active);
    page.tab.setAttribute("aria-selected", String(active)); page.tab.tabIndex = active ? 0 : -1;
    page.panel.setAttribute("aria-hidden", String(!active)); page.panel.inert = !active;
    if (!active && page.panel.contains(document.activeElement)) session.pages.get(key).tab.focus();
  }
  session.track.classList.toggle("is-immediate", immediate);
  session.track.style.transform = `translateX(-${pages.findIndex(page => page.key === key) * 100}%)`;
  // Commit immediate keyboard/initial positions before subsequent pointer transitions.
  if (immediate) session.track.getBoundingClientRect();
  const selected = session.pages.get(key);
  if (visit || !selected.file) loadPage(session, selected);
}
function syncDetail(session, meeting) {
  const previous = session.meeting; session.meeting = meeting;
  session.title.textContent = titleFor(meeting); session.date.textContent = formatDetailDate(meeting);
  session.metadata.textContent = `${formatTimeRange(meeting)} · Google Meet`;
  session.recovery.dispatchEvent(new CustomEvent("asterion:recovery-update", { detail: meeting }));
  const available = availableTabs(meeting);
  const keys = available.map(([, key]) => key);
  let changed = false;
  let focusRemoved = false;
  for (const [key, page] of session.pages) if (!keys.includes(key)) {
    focusRemoved ||= page.panel.contains(document.activeElement) || page.tab === document.activeElement;
    disposePage(page); page.panel.remove(); page.tab.remove(); session.pages.delete(key); changed = true;
  }
  const ordered = new Map();
  const icons = { transcript: "file-text", audio: "volume-2", video: "video", manifest: "braces" };
  for (const [, key, label] of available) {
    let page = session.pages.get(key);
    if (!page) {
      changed = true;
      const tab = document.createElement("button"); tab.type = "button"; tab.className = "detail-tab";
      tab.id = `detail-${session.id}-${key}-tab`; tab.setAttribute("role", "tab");
      tab.innerHTML = `${icon(icons[key], { size: 14, color: "currentColor" })}<span>${label}</span>`;
      const panel = document.createElement("section"); panel.className = "detail-page"; panel.id = `detail-${session.id}-${key}-panel`;
      panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id); tab.setAttribute("aria-controls", panel.id);
      const content = document.createElement("div"); content.className = `detail-tab-content is-${key}`;
      const loading = document.createElement("p"); loading.className = "detail-loading"; loading.textContent = t("history.loadingFile"); content.appendChild(loading); panel.appendChild(content);
      page = { key, tab, panel, content, revision: fileRevision(meeting, key), dirty: false, pending: null, file: null, media: null, url: null };
      tab.addEventListener("click", () => selectPage(session, key));
      tab.addEventListener("keydown", event => {
        const list = [...session.pages.keys()]; const index = list.indexOf(key);
        const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : event.key === "ArrowRight" ? (index + 1) % list.length : event.key === "ArrowLeft" ? (index + list.length - 1) % list.length : null;
        if (next === null) return;
        event.preventDefault(); selectPage(session, list[next], true); session.pages.get(list[next]).tab.focus();
      });
    } else if (page.revision !== fileRevision(meeting, key)) {
      page.revision = fileRevision(meeting, key); page.dirty = true;
      if (key !== "audio" && key !== "video" && page.file) loadPage(session, page);
    } else if (!page.file && previous !== meeting) page.dirty = true;
    ordered.set(key, page);
  }
  session.pages = ordered;
  // Reordering connected media nodes can interrupt playback; only move new/out-of-order pages.
  for (const [index, page] of [...ordered.values()].entries()) {
    if (session.tablist.children[index] !== page.tab) session.tablist.insertBefore(page.tab, session.tablist.children[index] ?? null);
    if (session.track.children[index] !== page.panel) session.track.insertBefore(page.panel, session.track.children[index] ?? null);
  }
  if (!ordered.has(state.selectedTab)) state.selectedTab = keys[0];
  selectPage(session, state.selectedTab, changed, false);
  if (focusRemoved) session.pages.get(state.selectedTab).tab.focus();
}
function updatePlaybackStatus(session) {
  if (session.closed) return;
  const active = [...session.pages.values()].find(page => page.media && page.media === session.playingMedia && !page.media.paused && !page.media.ended);
  for (const page of session.pages.values()) page.tab.classList.toggle("is-playing", page === active);
  session.playback.hidden = !active;
  session.pause.disabled = !active;
  const label = active ? t(active.key === "video" ? "history.playingVideo" : "history.playingAudio") : "";
  if (session.playbackLabel.textContent !== label) session.playbackLabel.textContent = label;
}
function mountDetailShell() {
  if (detailShell) return;
  detailShell = document.createElement("div"); detailShell.className = "detail-content";
  meetingRegion = document.createElement("div"); meetingRegion.className = "meeting-region";
  meetingFooter = document.createElement("footer"); meetingFooter.className = "meeting-footer";
  deleteMeetingButton = document.createElement("button"); deleteMeetingButton.type = "button"; deleteMeetingButton.className = "delete-meeting-button";
  deleteMeetingButton.innerHTML = `${icon("trash-2", { size: 14, color: "currentColor" })}<span>${t("common.deleteMeeting")}</span>`;
  deleteMeetingButton.addEventListener("click", () => { if (detailSession) showDeleteDialog(detailSession.meeting, deleteMeetingButton); });
  meetingFooter.appendChild(deleteMeetingButton); detailShell.append(meetingRegion, meetingFooter); detailPanelEl.replaceChildren(detailShell);
}
function renderDetail(animate = false) {
  mountDetailShell();
  const meeting = state.meetings.find(item => meetingId(item) === state.selectedMeetingId);
  if (meeting && detailSession?.meetingId === meetingId(meeting)) { syncDetail(detailSession, meeting); return; }
  const hadMeeting = Boolean(detailSession);
  const focusInside = meetingRegion.contains(document.activeElement);
  closeDetailSession(); meetingRegion.replaceChildren(); meetingFooter.hidden = !meeting;
  detailShell.classList.toggle("has-meeting", Boolean(meeting));
  if (!meeting) {
    const placeholder = document.createElement("p"); placeholder.className = "detail-placeholder"; placeholder.textContent = t("history.selectMeetingPlaceholder"); meetingRegion.appendChild(placeholder); return;
  }
  const header = document.createElement("header"); header.className = "detail-header";
  const title = document.createElement("h2"); title.className = "detail-title";
  const date = document.createElement("p"); date.className = "detail-date";
  const metadata = document.createElement("p"); metadata.className = "detail-metadata";
  const recovery = createRecoveryPanel(meeting); header.append(title, date, metadata, recovery);
  const tablist = document.createElement("div"); tablist.className = "detail-tabs"; tablist.setAttribute("role", "tablist");
  const navigation = document.createElement("div"); navigation.className = "detail-navigation";
  const playbackSlot = document.createElement("div"); playbackSlot.className = "playback-slot";
  const playback = document.createElement("div"); playback.className = "playback-status"; playback.hidden = true;
  const playbackLabel = document.createElement("span"); playbackLabel.setAttribute("role", "status");
  const pause = document.createElement("button"); pause.type = "button"; pause.className = "detail-action"; pause.textContent = t("common.pause"); pause.disabled = true;
  playback.append(playbackLabel, pause); playbackSlot.appendChild(playback);
  const viewport = document.createElement("div"); viewport.className = "detail-pager";
  const track = document.createElement("div"); track.className = "detail-track"; viewport.appendChild(track);
  navigation.append(tablist, playbackSlot);
  meetingRegion.append(header, navigation, viewport);
  const session = { id: ++nextDetailId, meetingId: meetingId(meeting), meeting, pages: new Map(), title, date, metadata, recovery, tablist, track, playback, playbackLabel, pause, closed: false, playIntent: null, playingMedia: null };
  detailSession = session;
  pause.addEventListener("click", () => {
    session.playIntent = null; session.playingMedia?.pause();
    if (playback.contains(document.activeElement)) session.pages.get(state.selectedTab)?.tab.focus();
  });
  syncDetail(session, meeting);
  if (focusInside) session.pages.get(state.selectedTab)?.tab.focus();
  if (hadMeeting && animate && meetingRegion.animate) {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    meetingAnimation = meetingRegion.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: reduced ? 120 : 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }
}
window.addEventListener("pagehide", closeDetailSession);
function showDeleteDialog(meeting, opener) {
  if (!meeting) return;
  const overlay = document.createElement("div"); overlay.className = "delete-modal-backdrop"; overlay.setAttribute("role", "presentation");
  const dialog = document.createElement("section"); dialog.className = "delete-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-labelledby", "delete-modal-title"); const title = document.createElement("h2"); title.id = "delete-modal-title"; title.textContent = t("common.deleteMeeting"); const body = document.createElement("p"); body.textContent = t("history.deleteConfirmBody", { title: titleFor(meeting) }); const actions = document.createElement("div"); actions.className = "delete-modal-actions"; const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "modal-cancel"; cancel.textContent = t("common.cancel"); const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = "modal-confirm"; confirm.textContent = t("common.delete"); actions.append(cancel, confirm); dialog.append(title, body, actions); overlay.appendChild(dialog); document.body.appendChild(overlay);
  const error = document.createElement("p"); error.className = "action-error"; error.setAttribute("role", "alert"); error.hidden = true; dialog.insertBefore(error, actions);
  const position = [...meetingsListEl.children].findIndex(card => card.dataset.meetingId === meetingId(meeting));
  const close = () => {
    document.removeEventListener("keydown", onKeydown); overlay.remove();
    const fallback = meetingsListEl.children[Math.max(0, Math.min(position, meetingsListEl.children.length - 1))]?.querySelector(".details-button");
    if (opener.isConnected && !opener.closest("[hidden]")) opener.focus(); else (fallback ?? searchInput).focus();
  };
  const onKeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } if (event.key === "Tab") { const controls = [...dialog.querySelectorAll("button:not([disabled])")]; const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } };
  cancel.addEventListener("click", close);
  confirm.disabled = pendingDeletes.has(meetingId(meeting));
  confirm.addEventListener("click", async () => {
    const id = meetingId(meeting); if (pendingDeletes.has(id)) return;
    pendingDeletes.add(id); confirm.disabled = true; dialog.setAttribute("aria-busy", "true"); error.hidden = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "asterion:delete-session", sessionId: meeting.sessionId, folderName: meeting.folderName });
      if (!result?.ok) throw new Error(result?.error ?? "Delete failed");
      state.meetings = state.meetings.filter(item => meetingId(item) !== id);
      if (state.selectedMeetingId === id) { state.selectedMeetingId = null; state.selectedTab = null; }
      renderAllExceptDetail(); renderDetail();
      if (overlay.isConnected) close();
    } catch {
      if (overlay.isConnected) { error.textContent = t("history.deleteError"); error.hidden = false; }
    } finally {
      pendingDeletes.delete(id); confirm.disabled = false; dialog.setAttribute("aria-busy", "false");
      document.querySelectorAll(".modal-confirm").forEach(button => { if (button.dataset.meetingId === id) button.disabled = false; });
    }
  });
  confirm.dataset.meetingId = meetingId(meeting);
  document.addEventListener("keydown", onKeydown); cancel.focus();
}
function renderAllExceptDetail() { renderSidebar(); renderMeetings(); }

searchInput.addEventListener("input", () => { state.search = searchInput.value; renderAllExceptDetail(); });
sortSelect.addEventListener("change", () => { state.sort = sortSelect.value; renderMeetings(); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.meetingHistory) return;
  state.meetings = Array.isArray(changes.meetingHistory.newValue) ? changes.meetingHistory.newValue : [];
  const selected = state.meetings.find(meeting => meetingId(meeting) === state.selectedMeetingId);
  if (state.selectedMeetingId && !selected) state.selectedMeetingId = null;
  renderAllExceptDetail();
  renderDetail();
});
chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => { state.meetings = Array.isArray(meetingHistory) ? meetingHistory : []; renderAllExceptDetail(); renderDetail(); });

// Reconciliation also discovers interrupted sessions missing from meetingHistory.
try { chrome.runtime.sendMessage({ type: "asterion:recover-storage" }).catch(() => {}); } catch {}
