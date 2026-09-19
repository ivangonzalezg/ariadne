import { icon } from "../shared/icons.js";

const searchInput = document.getElementById("search-input");
const filterChipsEl = document.getElementById("filter-chips");
const calendarEl = document.getElementById("calendar");
const kpisEl = document.getElementById("kpis");
const resultsCountEl = document.getElementById("results-count");
const sortSelect = document.getElementById("sort-select");
const meetingsListEl = document.getElementById("meetings-list");
const detailPanelEl = document.getElementById("detail-panel");
let activeMediaElement = null;
let activeMediaUrl = null;

document.getElementById("search-icon").innerHTML = icon("search", { size: 15, color: "var(--text-muted)" });
document.getElementById("sort-chevron").innerHTML = icon("chevron-down", { size: 12, color: "var(--text-muted)" });

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

function formatMonth(date) { return `${capitalize(new Intl.DateTimeFormat("es-ES", { month: "long" }).format(date))} ${date.getFullYear()}`; }
function capitalize(text) { return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text; }
function formatMeetingDate(meeting) {
  const started = new Date(meeting.startedAt);
  const ended = new Date(endTime(meeting));
  const date = capitalize(new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(started).replace(".", ""));
  const time = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} · ${time.format(started)} – ${time.format(ended)}`;
}
function formatDetailDate(meeting) { return capitalize(new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(meeting.startedAt))); }
function formatTimeRange(meeting) { const formatter = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false }); return `${formatter.format(new Date(meeting.startedAt))} – ${formatter.format(new Date(endTime(meeting)))}`; }
function formatDurationHours(totalMs) { const hours = Math.ceil((Math.max(0, totalMs) / 3600000) * 10) / 10; return `${hours} h`; }
function formatMediaTime(seconds) { if (!Number.isFinite(seconds) || seconds < 0) return "0:00"; const totalSeconds = Math.floor(seconds); return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`; }
function formatFileSize(bytes) { if (!Number.isFinite(bytes)) return ""; const units = ["B", "KB", "MB", "GB"]; let value = bytes; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; } return `${value.toLocaleString("es-ES", { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`; }
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
  const rows = [[String(thisMonth.length), "reuniones este mes"], [formatDurationHours(thisMonth.reduce((total, meeting) => total + durationOf(meeting), 0)), "de grabación"], [String(state.meetings.filter((meeting) => meeting.hasVideo).length), "reuniones con video"], [String(state.meetings.filter((meeting) => meeting.hasTranscript).length), "reuniones con transcripción"]];
  rows.forEach(([value, label]) => { const row = document.createElement("div"); row.className = "kpi-row"; const valueEl = document.createElement("strong"); valueEl.className = "kpi-value"; valueEl.textContent = value; const labelEl = document.createElement("span"); labelEl.className = "kpi-label"; labelEl.textContent = label; row.append(valueEl, labelEl); kpisEl.appendChild(row); });
}

function renderMeetings() {
  const meetings = deriveVisibleMeetings(state); resultsCountEl.textContent = `${meetings.length} resultados`; meetingsListEl.replaceChildren();
  if (!meetings.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Todavía no hay reuniones que coincidan con estos filtros."; meetingsListEl.appendChild(empty); return; }
  meetings.forEach((meeting) => meetingsListEl.appendChild(createMeetingCard(meeting)));
}

function closeOpenMoreMenu() {
  meetingsListEl.querySelector(".more-menu")?.remove();
  meetingsListEl.querySelectorAll(".more-button.is-open").forEach((button) => { button.classList.remove("is-open"); button.setAttribute("aria-expanded", "false"); });
}
document.addEventListener("click", closeOpenMoreMenu);

function openMeetingDetail(meeting, tab) {
  state.selectedMeetingId = meetingId(meeting); state.selectedTab = tab ?? null; renderMeetings(); renderDetail();
}

function createMeetingCard(meeting) {
  const card = document.createElement("article"); card.className = `meeting-card${meetingId(meeting) === state.selectedMeetingId ? " is-selected" : ""}`;
  card.addEventListener("click", () => openMeetingDetail(meeting));
  const header = document.createElement("div"); header.className = "meeting-card-header";
  const title = document.createElement("h3"); title.className = "meeting-title"; title.textContent = titleFor(meeting);
  const moreWrap = document.createElement("div"); moreWrap.className = "more-wrap";
  const more = document.createElement("button"); more.type = "button"; more.className = "more-button"; more.setAttribute("aria-label", "Más opciones"); more.setAttribute("aria-haspopup", "true"); more.setAttribute("aria-expanded", "false"); more.innerHTML = icon("ellipsis", { size: 17, color: "currentColor" });
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasOpen = more.classList.contains("is-open");
    closeOpenMoreMenu();
    if (wasOpen) return;
    more.classList.add("is-open"); more.setAttribute("aria-expanded", "true");
    const menu = document.createElement("div"); menu.className = "more-menu"; menu.setAttribute("role", "menu");
    const deleteItem = document.createElement("button"); deleteItem.type = "button"; deleteItem.className = "more-menu-item"; deleteItem.setAttribute("role", "menuitem");
    deleteItem.innerHTML = icon("trash-2", { size: 14, color: "currentColor" });
    deleteItem.appendChild(document.createTextNode("Eliminar reunión"));
    deleteItem.addEventListener("click", (deleteEvent) => { deleteEvent.stopPropagation(); closeOpenMoreMenu(); showDeleteDialog(meeting, more); });
    menu.appendChild(deleteItem);
    moreWrap.appendChild(menu);
  });
  moreWrap.appendChild(more);
  header.append(title, moreWrap);
  const date = document.createElement("p"); date.className = "meeting-date"; date.textContent = formatMeetingDate(meeting);
  const chips = document.createElement("div"); chips.className = "file-chips";
  [[meeting.hasTranscript, "file-text", "Transcripción", "transcript"], [true, "volume-2", "Audio", "audio"], [meeting.hasVideo, "video", "Video", "video"], [true, "braces", "Manifest", "manifest"]].forEach(([available, iconName, label, tab]) => {
    const chip = document.createElement("span"); chip.className = `file-chip${available ? " is-available" : " is-unavailable"}`;
    chip.innerHTML = icon(iconName, { size: 12, color: "currentColor" });
    chip.appendChild(document.createTextNode(label));
    if (available) { chip.setAttribute("role", "button"); chip.tabIndex = 0; chip.addEventListener("click", (event) => { event.stopPropagation(); openMeetingDetail(meeting, tab); }); }
    chips.appendChild(chip);
  });
  const detailsRow = document.createElement("div"); detailsRow.className = "details-row";
  const details = document.createElement("button"); details.type = "button"; details.className = "details-button"; details.textContent = "Ver detalles";
  detailsRow.appendChild(details);
  card.append(header, date, chips, detailsRow); return card;
}

function availableTabs(meeting) { return [[meeting.hasTranscript, "transcript", "Transcripción"], [true, "audio", "Audio"], [meeting.hasVideo, "video", "Video"], [true, "manifest", "Manifest"]].filter(([available]) => available); }
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
  if (tab === "transcript") { const file = await (await directory.getFileHandle("transcripcion.txt")).getFile(); return { file, name: "transcripcion.txt", text: await file.text() }; }
  if (tab === "manifest") { const { file, value } = await readJsonFile(directory); return { file, name: "manifest.json", value }; }
  const { value: manifest } = await readJsonFile(directory).catch(() => ({ value: {} }));
  const isVideo = tab === "video"; const converted = isVideo ? (manifest.hasVideoMp4 || manifest.videoConversionStatus === "succeeded") : (manifest.hasAudioMp3 || manifest.audioConversionStatus === "succeeded");
  const preferred = isVideo ? (converted ? "video-reunion.mp4" : "video-reunion.webm") : (converted ? "audio-reunion.mp3" : "audio-reunion.webm");
  const fallback = isVideo ? (preferred.endsWith(".mp4") ? "video-reunion.webm" : "video-reunion.mp4") : (preferred.endsWith(".mp3") ? "audio-reunion.webm" : "audio-reunion.mp3");
  try { return { file: await (await directory.getFileHandle(preferred)).getFile(), name: preferred }; } catch { return { file: await (await directory.getFileHandle(fallback)).getFile(), name: fallback }; }
}
function parseTranscript(text) { return text.split("\n").map((line) => line.match(/^\[(\d{2}:\d{2})\] \[(.*?)\] (.*)$/)).filter(Boolean).map((match) => ({ timestamp: match[1], speaker: match[2], text: match[3] })); }
function createFileFooter(activeFile) {
  const footer = document.createElement("footer"); footer.className = "detail-footer";
  const metadata = document.createElement("span"); metadata.className = "detail-file-meta"; metadata.textContent = `${activeFile.name} · ${formatFileSize(activeFile.file.size)}`;
  const actions = document.createElement("div"); actions.className = "detail-file-actions";
  const view = document.createElement("button"); view.type = "button"; view.className = "detail-action"; view.textContent = "Abrir"; view.addEventListener("click", () => viewFile(activeFile.file));
  const download = document.createElement("button"); download.type = "button"; download.className = "detail-action"; download.textContent = "Descargar"; download.addEventListener("click", () => downloadFile(activeFile.file, activeFile.name));
  const separator = document.createElement("span"); separator.className = "detail-footer-separator"; separator.setAttribute("aria-hidden", "true");
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-meeting-button"; remove.textContent = "Eliminar reunión"; remove.addEventListener("click", () => showDeleteDialog(state.meetings.find((item) => meetingId(item) === state.selectedMeetingId), remove));
  actions.append(view, download, separator, remove); footer.append(metadata, actions); return footer;
}
function cleanupActiveMedia() {
  if (activeMediaElement) { activeMediaElement.pause(); activeMediaElement.removeAttribute("src"); activeMediaElement.load(); activeMediaElement = null; }
  if (activeMediaUrl) { URL.revokeObjectURL(activeMediaUrl); activeMediaUrl = null; }
}
function createMediaButton(className, label, iconName, size = 18) {
  const button = document.createElement("button"); button.type = "button"; button.className = className; button.setAttribute("aria-label", label); button.title = label; button.innerHTML = icon(iconName, { size, color: "currentColor" }); return button;
}
function setRangeProgress(range, value, max) { range.style.setProperty("--range-progress", `${max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0}%`); }
function createMediaPlayer(activeFile, isVideo) {
  const player = document.createElement("div"); player.className = `custom-media-player${isVideo ? " custom-video-player" : " custom-audio-player"}`;
  const media = document.createElement(isVideo ? "video" : "audio"); media.className = isVideo ? "custom-video-element" : "custom-audio-element"; media.preload = "metadata"; media.controls = false;
  const sourceUrl = URL.createObjectURL(activeFile.file); activeMediaElement = media; activeMediaUrl = sourceUrl;
  const seek = document.createElement("input"); seek.type = "range"; seek.className = "media-seek"; seek.min = "0"; seek.max = "0"; seek.value = "0"; seek.step = "0.1"; seek.disabled = true; seek.setAttribute("aria-label", "Posición de reproducción");
  const time = document.createElement("span"); time.className = "media-time";
  const volume = document.createElement("input"); volume.type = "range"; volume.className = "media-volume"; volume.min = "0"; volume.max = "1"; volume.value = "1"; volume.step = "0.05"; volume.setAttribute("aria-label", "Volumen"); setRangeProgress(volume, 1, 1);
  const play = createMediaButton("media-play", "Reproducir", "play", isVideo ? 18 : 22);
  const update = () => { const duration = Number.isFinite(media.duration) ? media.duration : 0; seek.max = String(duration); seek.disabled = duration <= 0; seek.value = String(Math.min(media.currentTime || 0, duration)); setRangeProgress(seek, Number(seek.value), duration); time.textContent = `${formatMediaTime(media.currentTime)} / ${formatMediaTime(duration)}`; };
  const updatePlayButton = () => { const paused = media.paused || media.ended; play.setAttribute("aria-label", paused ? "Reproducir" : "Pausar"); play.title = paused ? "Reproducir" : "Pausar"; play.innerHTML = icon(paused ? "play" : "pause", { size: isVideo ? 18 : 22, color: "currentColor" }); player.classList.toggle("is-playing", !paused); };
  const togglePlayback = async () => { if (media.paused || media.ended) { try { await media.play(); } catch { updatePlayButton(); } } else media.pause(); };
  play.addEventListener("click", togglePlayback); seek.addEventListener("input", () => { if (!seek.disabled) media.currentTime = Number(seek.value); update(); }); volume.addEventListener("input", () => { media.volume = Number(volume.value); setRangeProgress(volume, media.volume, 1); });
  media.addEventListener("loadedmetadata", update); media.addEventListener("durationchange", update); media.addEventListener("timeupdate", update); media.addEventListener("play", updatePlayButton); media.addEventListener("pause", updatePlayButton); media.addEventListener("ended", () => { update(); updatePlayButton(); }); media.addEventListener("error", () => { const error = document.createElement("p"); error.className = "media-error"; error.textContent = "No se pudo cargar este archivo multimedia."; player.appendChild(error); });
  if (isVideo) {
    const controls = document.createElement("div"); controls.className = "video-controls"; const volumeWrap = document.createElement("label"); volumeWrap.className = "media-volume-control"; volumeWrap.setAttribute("aria-label", "Volumen"); volumeWrap.innerHTML = icon("volume-2", { size: 17, color: "currentColor" }); volumeWrap.appendChild(volume);
    const fullscreen = createMediaButton("media-control-button", "Pantalla completa", "maximize", 17); fullscreen.addEventListener("click", () => { media.requestFullscreen().catch(() => {}); });
    const largePlay = createMediaButton("video-large-play", "Reproducir video", "play", 28); largePlay.addEventListener("click", togglePlayback); controls.append(play, seek, time, volumeWrap, fullscreen); player.append(media, largePlay, controls);
  } else {
    const label = document.createElement("p"); label.className = "audio-player-label"; label.textContent = "Audio de la reunión"; const transport = document.createElement("div"); transport.className = "audio-transport"; const rewind = createMediaButton("media-control-button", "Retroceder 10 segundos", "rotate-ccw"); rewind.addEventListener("click", () => { media.currentTime = Math.max(0, media.currentTime - 10); }); const forward = createMediaButton("media-control-button", "Adelantar 10 segundos", "fast-forward"); forward.addEventListener("click", () => { media.currentTime = Math.min(Number.isFinite(media.duration) ? media.duration : media.currentTime + 10, media.currentTime + 10); }); transport.append(rewind, play, forward, time);
    const volumeWrap = document.createElement("label"); volumeWrap.className = "media-volume-control"; volumeWrap.setAttribute("aria-label", "Volumen"); volumeWrap.innerHTML = icon("volume-2", { size: 18, color: "var(--text-secondary)" }); volumeWrap.appendChild(volume); player.append(label, media, transport, seek, volumeWrap);
  }
  media.src = sourceUrl; update(); return player;
}
function renderTabContent(content, activeFile) {
  if (state.selectedTab === "transcript") {
    const list = document.createElement("div"); list.className = "transcript-list";
    parseTranscript(activeFile.text).forEach((entry) => { const row = document.createElement("div"); row.className = "transcript-row"; const timestamp = document.createElement("time"); timestamp.className = "transcript-time"; timestamp.textContent = entry.timestamp; const spoken = document.createElement("p"); spoken.className = "transcript-spoken"; const speaker = document.createElement("strong"); speaker.textContent = entry.speaker; spoken.append(speaker, document.createTextNode(` ${entry.text}`)); row.append(timestamp, spoken); list.appendChild(row); });
    if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "detail-empty"; empty.textContent = "No se encontraron intervenciones en la transcripción."; content.appendChild(empty); } else content.appendChild(list);
  } else if (state.selectedTab === "manifest") { const code = document.createElement("pre"); code.className = "manifest-code"; code.innerHTML = highlightJson(activeFile.value); content.appendChild(code); }
  else content.appendChild(createMediaPlayer(activeFile, state.selectedTab === "video"));
}
async function renderDetail() {
  cleanupActiveMedia(); detailPanelEl.replaceChildren(); const meeting = state.meetings.find((item) => meetingId(item) === state.selectedMeetingId);
  if (!meeting) { const placeholder = document.createElement("p"); placeholder.className = "detail-placeholder"; placeholder.textContent = "Seleccioná una reunión para ver el detalle"; detailPanelEl.appendChild(placeholder); return; }
  const tabs = availableTabs(meeting); if (!tabs.some(([, key]) => key === state.selectedTab)) state.selectedTab = tabs[0][1];
  const renderKey = `${meetingId(meeting)}:${state.selectedTab}`;
  const detail = document.createElement("div"); detail.className = "detail-content";
  const header = document.createElement("header"); header.className = "detail-header"; const title = document.createElement("h2"); title.className = "detail-title"; title.textContent = titleFor(meeting); const date = document.createElement("p"); date.className = "detail-date"; date.textContent = formatDetailDate(meeting); const metadata = document.createElement("p"); metadata.className = "detail-metadata"; metadata.textContent = `${formatTimeRange(meeting)} · Google Meet`; header.append(title, date, metadata);
  const tablist = document.createElement("div"); tablist.className = "detail-tabs"; tablist.setAttribute("role", "tablist"); tabs.forEach(([, key, label]) => { const tab = document.createElement("button"); const active = key === state.selectedTab; tab.type = "button"; tab.className = `detail-tab${active ? " is-active" : ""}`; tab.textContent = label; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(active)); tab.addEventListener("click", () => { state.selectedTab = key; renderDetail(); }); tablist.appendChild(tab); });
  const content = document.createElement("section"); content.className = "detail-tab-content"; content.setAttribute("role", "tabpanel"); const loading = document.createElement("p"); loading.className = "detail-loading"; loading.textContent = "Cargando archivo..."; content.appendChild(loading); detail.append(header, tablist, content); detailPanelEl.appendChild(detail);
  try { const activeFile = await readActiveFile(meeting, state.selectedTab); if (`${state.selectedMeetingId}:${state.selectedTab}` !== renderKey) return; content.replaceChildren(); renderTabContent(content, activeFile); detail.appendChild(createFileFooter(activeFile)); } catch (error) { if (`${state.selectedMeetingId}:${state.selectedTab}` !== renderKey) return; content.replaceChildren(); const unavailable = document.createElement("p"); unavailable.className = "detail-empty"; unavailable.textContent = "No se pudo abrir este archivo de la reunión."; content.appendChild(unavailable); }
}
function showDeleteDialog(meeting, opener) {
  if (!meeting) return;
  const overlay = document.createElement("div"); overlay.className = "delete-modal-backdrop"; overlay.setAttribute("role", "presentation");
  const dialog = document.createElement("section"); dialog.className = "delete-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-labelledby", "delete-modal-title"); const title = document.createElement("h2"); title.id = "delete-modal-title"; title.textContent = "Eliminar reunión"; const body = document.createElement("p"); body.textContent = `Se eliminarán ${titleFor(meeting)} y todos sus archivos de este dispositivo. Esta acción es permanente y no se puede deshacer.`; const actions = document.createElement("div"); actions.className = "delete-modal-actions"; const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "modal-cancel"; cancel.textContent = "Cancelar"; const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = "modal-confirm"; confirm.textContent = "Eliminar"; actions.append(cancel, confirm); dialog.append(title, body, actions); overlay.appendChild(dialog); document.body.appendChild(overlay);
  const close = () => { document.removeEventListener("keydown", onKeydown); overlay.remove(); opener.focus(); };
  const onKeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } if (event.key === "Tab") { const controls = [...dialog.querySelectorAll("button:not([disabled])")]; const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } };
  cancel.addEventListener("click", close); confirm.addEventListener("click", async () => { confirm.disabled = true; try { const root = await navigator.storage.getDirectory(); await root.removeEntry(meeting.folderName, { recursive: true }); const meetingHistory = state.meetings.filter((item) => meetingId(item) !== meetingId(meeting)); await chrome.storage.local.set({ meetingHistory }); state.meetings = meetingHistory; state.selectedMeetingId = null; state.selectedTab = null; renderAllExceptDetail(); renderDetail(); close(); } catch { confirm.disabled = false; } });
  document.addEventListener("keydown", onKeydown); cancel.focus();
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
