export function captionStatusLabel(meta, t) {
  if (meta.captionStorage?.error) return t("transcript.storageError");
  if (meta.captionStorage?.pending) return t("transcript.saving");
  const state = meta.captionState ?? (meta.transcriptActive ? "active" : "preparing");
  return t({ active: "popup.activeFem", paused: "transcript.paused", recovering: "transcript.recovering",
    error: "transcript.error", preparing: "transcript.preparing" }[state] ?? "transcript.preparing");
}
