// src/history/history.js
const listEl = document.getElementById("history-list");

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

async function renderMeetingFiles(li, folderName) {
  const filesEl = document.createElement("div");
  filesEl.className = "files";
  li.appendChild(filesEl);

  const root = await navigator.storage.getDirectory();
  const meetingHandle = await root.getDirectoryHandle(folderName);

  for await (const [name, handle] of meetingHandle.entries()) {
    if (handle.kind !== "file") continue;
    const button = document.createElement("button");
    button.textContent = `Descargar ${name}`;
    button.addEventListener("click", async () => {
      const file = await handle.getFile();
      downloadFile(file, `${folderName}/${name}`);
    });
    filesEl.appendChild(button);
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
    const label = document.createElement("div");
    label.textContent = `${date} — ${meeting.folderName}${flags ? ` (${flags})` : ""}`;
    li.appendChild(label);

    renderMeetingFiles(li, meeting.folderName);

    listEl.appendChild(li);
  }
});
