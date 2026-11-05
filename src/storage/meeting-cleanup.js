import { CAPTURE_STATE_FILE, readJson, writeFile } from "./capture-journal.js";
import { MEETING_CLEANUP_VERSION } from "./meeting-cleanup-state.js";
import { hasFile } from "./session-recovery.js";

async function removeIfPresent(directory, name, options) {
  try { await directory.removeEntry(name, options); }
  catch (error) { if (error.name !== "NotFoundError") throw error; }
}

async function removeRecords(directory, name, pattern) {
  let records;
  try { records = await directory.getDirectoryHandle(name); }
  catch (error) { if (error.name === "NotFoundError") return; throw error; }
  const removable = [];
  let hasUnknownEntries = false;
  for await (const entry of records.values()) {
    if (entry.kind === "file" && pattern.test(entry.name)) removable.push(entry.name);
    else hasUnknownEntries = true;
  }
  if (!hasUnknownEntries) await removeIfPresent(directory, name, { recursive: true });
  else for (const filename of removable) await removeIfPresent(records, filename);
}

// Meet can journal the local speaker identity even when nobody spoke.
async function onlySavedIdentities(directory, state) {
  let records;
  try { records = await directory.getDirectoryHandle("caption-records"); }
  catch (error) {
    if (error.name === "NotFoundError") return !state.expectedCaptionEvents || Boolean(state.cleanup);
    throw error;
  }
  let count = 0;
  for await (const entry of records.values()) {
    if (entry.kind !== "file" || !/^\d+\.json$/.test(entry.name)) continue;
    let event;
    try { ({ event } = await readJson(records, entry.name)); }
    catch (error) { if (error instanceof SyntaxError) return false; throw error; }
    if (event?.kind !== "local-identity" || event.sessionId !== state.sessionId ||
        !state.localIdentity || event.identity?.speakerId !== state.localIdentity.speakerId ||
        event.identity?.name !== state.localIdentity.name) return false;
    count++;
  }
  return Boolean(state.cleanup) || count >= (state.expectedCaptionEvents ?? 0);
}

export async function cleanMeeting(directory, state, beforeCleanup) {
  if (state?.cleanup && state.cleanup.version !== MEETING_CLEANUP_VERSION) return "pending";
  if (state?.cleanup?.status === "complete") return "complete";
  const retained = state?.cleanup ? "pending" : "retained";
  if (state?.recordingStatus !== "complete" || state.interruptionReason || state.transcriptStatus === "incomplete" ||
      state.invalidRecords?.length || state.persistenceErrors?.length || state.captionPersistenceErrors?.length ||
      Object.values(state.recoveredCoverage ?? {}).some(coverage => coverage.partial || coverage.gaps?.length)) {
    return retained;
  }
  const jobs = [...(state.conversions ?? []), ...(state.recoveryTasks ?? [])];
  if (!jobs.some(job => job.stream === "publication") ||
      jobs.some(job => job.state !== "succeeded" || !job.published)) return retained;
  let manifest;
  try { manifest = await readJson(directory, "manifest.json"); }
  catch (error) { if (error.name === "NotFoundError" || error instanceof SyntaxError) return retained; throw error; }
  if (manifest?.sessionId !== state.sessionId || manifest.transcriptStatus === "incomplete") return retained;

  const succeeded = stream => jobs.some(job => job.stream === stream);
  const hasVideo = manifest.hasVideo || state.expectedSequences?.video || succeeded("video") ||
    state.captureSegments?.some(segment => segment.stream === "video") || await hasFile(directory, "video-reunion.webm");
  const hasCaptions = manifest.hasTranscript || state.transcriptExported ||
    state.captionSnapshots?.length || succeeded("transcript");
  if (!succeeded("meeting") || !(await hasFile(directory, "audio-reunion.mp3")) ||
      (hasVideo && (!succeeded("video") || !(await hasFile(directory, "video-reunion.mp4")))) ||
      (hasCaptions && (!succeeded("transcript") || !(await hasFile(directory, "transcripcion.json"))))) return retained;

  if (hasCaptions) {
    let transcript;
    try { transcript = await readJson(directory, "transcripcion.json"); }
    catch (error) { if (error.name === "NotFoundError" || error instanceof SyntaxError) return retained; throw error; }
    if (!Array.isArray(transcript) || !transcript.length || transcript.some(segment => typeof segment?.text !== "string")) return retained;
  } else if (!(await onlySavedIdentities(directory, state))) return retained;
  if (!(await beforeCleanup())) return "pending";
  state.cleanup = { version: MEETING_CLEANUP_VERSION, status: "pending" };
  await writeFile(directory, CAPTURE_STATE_FILE, JSON.stringify(state));
  await removeRecords(directory, "capture-records", hasVideo ? /^(meeting|video)-\d+-\d+\.chunk$/ : /^meeting-\d+-\d+\.chunk$/);
  await removeRecords(directory, "caption-records", /^\d+\.json$/);
  const segments = [];
  for await (const entry of directory.values()) {
    if (entry.kind === "file" && (/^meeting-segment-\d+\.webm$/.test(entry.name) ||
        (hasVideo && /^video-segment-\d+\.webm$/.test(entry.name)))) segments.push(entry.name);
  }
  for (const name of segments) await removeIfPresent(directory, name);
  await removeIfPresent(directory, "audio-reunion.webm");
  if (hasVideo) await removeIfPresent(directory, "video-reunion.webm");
  if (Object.hasOwn(manifest, "captureSegments")) {
    delete manifest.captureSegments;
    await writeFile(directory, "manifest.json", JSON.stringify(manifest, null, 2));
  }
  delete state.captureSegments;
  delete state.captionSnapshots;
  delete state.speakerLabels;
  state.cleanup.status = "complete";
  await writeFile(directory, CAPTURE_STATE_FILE, JSON.stringify(state));
  return "complete";
}
