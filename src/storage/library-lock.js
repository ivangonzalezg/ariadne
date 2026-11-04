export const LIBRARY_LOCK = "ariadne-meeting-library";
export const BACKUP_BUSY = "BACKUP_BUSY";
export const PENDING_IMPORT = "pendingMeetingBackupImport";

export function withLibraryWrite(operation, { rejectIfBusy = false } = {}) {
  if (!navigator.locks) return operation();
  return navigator.locks.request(LIBRARY_LOCK, { mode: "shared", ifAvailable: rejectIfBusy }, lock => {
    if (!lock) return { error: "A meeting backup is in progress", code: BACKUP_BUSY, retryable: true };
    return operation();
  });
}

// The exclusive lock prevents recovery from seeing a live import transaction.
export async function rollbackPendingImport() {
  const { [PENDING_IMPORT]: pending, meetingHistory } = await chrome.storage.local.get({
    [PENDING_IMPORT]: null, meetingHistory: [],
  });
  if (!pending) return;
  const published = new Set(meetingHistory.map(entry => entry.folderName));
  const root = await navigator.storage.getDirectory();
  for (const name of pending.folders) {
    if (!/^restore-[0-9a-f-]{36}$/.test(name) || published.has(name)) continue;
    try {
      await root.removeEntry(name, { recursive: true });
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
  }
  await chrome.storage.local.set({ [PENDING_IMPORT]: null });
}
