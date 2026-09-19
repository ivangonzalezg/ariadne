export function formatSegmentTimestamp(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function transcriptToTxt(segments) {
  return segments
    .map((segment) => `[${formatSegmentTimestamp(segment.startTime)}] [${segment.speaker}] ${segment.text.replace(/\s*\n+\s*/g, " ").trim()}`)
    .join("\n");
}

export function transcriptToMarkdown(segments, meetingTitle) {
  const heading = `# ${meetingTitle}\n\n`;
  const body = segments
    .map((segment) => `**${segment.speaker}** _[${formatSegmentTimestamp(segment.startTime)}]_\n${segment.text}`)
    .join("\n\n");
  return `${heading}${body}\n`;
}
