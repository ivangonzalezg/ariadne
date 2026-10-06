function normalizeFilenamePart(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function meetingDownloadFilename(meetingTitle, fileTypeLabel, extension, untitledMeetingLabel) {
  const title = normalizeFilenamePart(meetingTitle) || normalizeFilenamePart(untitledMeetingLabel);
  return `${title}-${normalizeFilenamePart(fileTypeLabel)}.${extension}`;
}
