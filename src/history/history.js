// src/history/history.js
import { loadRootDirectoryHandle } from "../storage/directory-handle-store.js";

const listEl = document.getElementById("history-list");

async function openMeetingFolder(folderName) {
  const rootHandle = await loadRootDirectoryHandle();
  if (!rootHandle) return;
  const meetingHandle = await rootHandle.getDirectoryHandle(folderName);
  for await (const [name, handle] of meetingHandle.entries()) {
    if (handle.kind !== "file") continue;
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, "_blank");
  }
}

chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
  if (meetingHistory.length === 0) {
    listEl.innerHTML = "<li>Todavía no hay reuniones grabadas.</li>";
    return;
  }

  for (const meeting of meetingHistory) {
    const li = document.createElement("li");
    const date = new Date(meeting.startedAt).toLocaleString();
    const flags = [meeting.hasTranscript ? "transcripción" : null, meeting.hasVideo ? "video" : null]
      .filter(Boolean)
      .join(", ");
    li.textContent = `${date} — ${meeting.folderName}${flags ? ` (${flags})` : ""}`;

    const openButton = document.createElement("button");
    openButton.textContent = "Abrir archivos";
    openButton.addEventListener("click", () => openMeetingFolder(meeting.folderName));
    li.appendChild(openButton);

    listEl.appendChild(li);
  }
});
