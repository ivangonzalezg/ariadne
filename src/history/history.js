// src/history/history.js
import { icon } from "../shared/icons.js";

const listEl = document.getElementById("history-list");
const backButton = document.getElementById("back-button");

backButton.innerHTML = icon("chevron-left", { size: 18, color: "var(--text-secondary)" });
backButton.addEventListener("click", () => {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.close();
  }
});

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
  // No se revoca el object URL acá: la pestaña nueva necesita poder seguir
  // leyendo el archivo mientras el usuario lo mira/escucha/reproduce.
  const url = URL.createObjectURL(file);
  chrome.tabs.create({ url });
}

async function renderMeetingFiles(container, folderName) {
  const root = await navigator.storage.getDirectory();
  const meetingHandle = await root.getDirectoryHandle(folderName);

  for await (const [name, handle] of meetingHandle.entries()) {
    if (handle.kind !== "file") continue;
    const file = await handle.getFile();

    const viewButton = document.createElement("button");
    viewButton.className = "action-button";
    viewButton.textContent = `Ver ${name}`;
    viewButton.addEventListener("click", () => viewFile(file));
    container.appendChild(viewButton);

    const downloadButton = document.createElement("button");
    downloadButton.className = "action-button";
    downloadButton.textContent = `Descargar ${name}`;
    downloadButton.addEventListener("click", () => downloadFile(file, `${folderName}/${name}`));
    container.appendChild(downloadButton);
  }
}

async function deleteMeeting(folderName) {
  if (!confirm(`¿Eliminar la reunión "${folderName}"? Esto borra sus archivos y no se puede deshacer.`)) {
    return;
  }

  const root = await navigator.storage.getDirectory();
  await root.removeEntry(folderName, { recursive: true }).catch(() => {});

  chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
    const updated = meetingHistory.filter((meeting) => meeting.folderName !== folderName);
    chrome.storage.local.set({ meetingHistory: updated }, () => {
      render(updated);
    });
  });
}

function render(meetingHistory) {
  listEl.innerHTML = "";

  if (meetingHistory.length === 0) {
    listEl.innerHTML = '<li class="empty-state">Todavía no hay reuniones grabadas.</li>';
    return;
  }

  for (const meeting of meetingHistory) {
    const li = document.createElement("li");
    li.className = "meeting-card";
    const date = new Date(meeting.startedAt).toLocaleString();

    const title = document.createElement("h2");
    title.className = "meeting-title";
    title.textContent = meeting.meetingTitle || meeting.folderName;
    li.appendChild(title);

    const dateLabel = document.createElement("p");
    dateLabel.className = "meeting-date";
    dateLabel.textContent = date;
    li.appendChild(dateLabel);

    const deleteButton = document.createElement("button");
    deleteButton.className = "action-button delete-button";
    deleteButton.textContent = "Eliminar reunión";
    deleteButton.addEventListener("click", () => deleteMeeting(meeting.folderName));
    li.appendChild(deleteButton);

    const filesEl = document.createElement("div");
    filesEl.className = "files";
    li.appendChild(filesEl);
    renderMeetingFiles(filesEl, meeting.folderName);

    listEl.appendChild(li);
  }
}

chrome.storage.local.get({ meetingHistory: [] }, ({ meetingHistory }) => {
  render(meetingHistory);
});
