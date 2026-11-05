export const MEETING_CLEANUP_VERSION = 1;

export function meetingCleanupChecked(meeting) {
  const cleanup = meeting.cleanup;
  return cleanup?.version === MEETING_CLEANUP_VERSION &&
    cleanup.revision === (meeting.processing?.revision ?? null) &&
    ["complete", "retained"].includes(cleanup.status);
}
