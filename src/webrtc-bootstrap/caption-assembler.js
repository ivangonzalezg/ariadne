const DEFAULT_INACTIVITY_MS = 2000;
const DEFAULT_GROUP_FINALIZATION_GRACE_MS = 500;
const DEFAULT_FINALIZED_CAPTION_TTL_MS = 30_000;
const DEFAULT_MAX_FINALIZED_CAPTION_FINGERPRINTS = 512;

function isNullish(value) {
  return value === null || value === undefined;
}

function receivedAt(metadata) {
  return Number.isFinite(metadata?.receivedAtMs) ? metadata.receivedAtMs : Date.now();
}

function fingerprintValue(value) {
  const stringValue = String(value);
  return `${typeof value}:${stringValue.length}:${stringValue}`;
}

// Include all fields that identify a decoded caption revision. Type and length
// delimit each part so values containing separators cannot collide.
function finalizedCaptionFingerprint(caption) {
  return [caption.schema, caption.deviceSpace, caption.captionId, caption.version, caption.isFinal, caption.text]
    .map(fingerprintValue)
    .join("|");
}

function groupedCaptionIdFingerprint(deviceSpace, captionId) {
  return [deviceSpace, captionId].map(fingerprintValue).join("|");
}

/**
 * Collects caption revisions until Meet marks one final or a v1 caption goes idle.
 *
 * `version` is supplied by protobuf-lite as either a Number or BigInt. Relational
 * comparisons intentionally use JavaScript's native mixed numeric comparison: it
 * compares exactly without coercing a BigInt to an unsafe Number.
 */
export function createCaptionAssembler({
  onCaptionFinalized,
  inactivityMs = DEFAULT_INACTIVITY_MS,
  groupFinalizationGraceMs = DEFAULT_GROUP_FINALIZATION_GRACE_MS,
  finalizedCaptionTtlMs = DEFAULT_FINALIZED_CAPTION_TTL_MS,
  maxFinalizedCaptionFingerprints = DEFAULT_MAX_FINALIZED_CAPTION_FINGERPRINTS,
}) {
  const captionGroups = new Map();
  const recentlyFinalized = new Map();
  const recentlyFinalizedGroupedCaptionIds = new Map();

  function pruneRecentlyFinalized(now) {
    for (const [fingerprint, finalizedAtMs] of recentlyFinalized) {
      if (now - finalizedAtMs < finalizedCaptionTtlMs) break;
      recentlyFinalized.delete(fingerprint);
    }
    while (recentlyFinalized.size > maxFinalizedCaptionFingerprints) {
      recentlyFinalized.delete(recentlyFinalized.keys().next().value);
    }
  }

  function rememberFinalizedCaption(entry) {
    const now = Date.now();
    recentlyFinalized.set(finalizedCaptionFingerprint(entry), now);
    pruneRecentlyFinalized(now);
  }

  function pruneRecentlyFinalizedGroupedCaptionIds(now) {
    for (const [captionKey, finalizedAtMs] of recentlyFinalizedGroupedCaptionIds) {
      if (now - finalizedAtMs < finalizedCaptionTtlMs) break;
      recentlyFinalizedGroupedCaptionIds.delete(captionKey);
    }
    while (recentlyFinalizedGroupedCaptionIds.size > maxFinalizedCaptionFingerprints) {
      recentlyFinalizedGroupedCaptionIds.delete(recentlyFinalizedGroupedCaptionIds.keys().next().value);
    }
  }

  function finalizeGroup(group) {
    if (captionGroups.get(group.deviceSpace) !== group) return;
    if (group.finalizationGraceTimer !== null) clearTimeout(group.finalizationGraceTimer);
    captionGroups.delete(group.deviceSpace);

    const entries = [...group.entries.values()];
    for (const entry of entries) {
      if (entry.inactivityTimer !== null) clearTimeout(entry.inactivityTimer);
      rememberFinalizedCaption(entry);
    }
    if (entries.length > 1) {
      const now = Date.now();
      for (const entry of entries) {
        recentlyFinalizedGroupedCaptionIds.set(groupedCaptionIdFingerprint(entry.deviceSpace, entry.captionId), now);
      }
      pruneRecentlyFinalizedGroupedCaptionIds(now);
    }

    const longestEntry = entries.reduce((longest, entry) => (
      entry.text.length > longest.text.length ? entry : longest
    ));
    onCaptionFinalized({
      captionId: group.leaderCaptionId,
      deviceSpace: group.deviceSpace,
      text: longestEntry.text,
      startMs: Math.min(...entries.map((entry) => entry.firstReceivedAtMs)),
      endMs: Math.max(...entries.map((entry) => entry.lastUpdatedAtMs)),
    });
  }

  function completeEntry(group, entry) {
    if (captionGroups.get(group.deviceSpace) !== group || entry.isComplete) return;
    entry.isComplete = true;
    if (entry.inactivityTimer !== null) {
      clearTimeout(entry.inactivityTimer);
      entry.inactivityTimer = null;
    }

    if ([...group.entries.values()].every((candidate) => candidate.isComplete)) {
      finalizeGroup(group);
    } else if (entry.captionId === group.leaderCaptionId) {
      group.finalizationGraceTimer = setTimeout(() => finalizeGroup(group), groupFinalizationGraceMs);
    }
  }

  function scheduleV1Finalization(group, entry) {
    if (entry.inactivityTimer !== null) clearTimeout(entry.inactivityTimer);
    entry.inactivityTimer = setTimeout(() => completeEntry(group, entry), inactivityMs);
  }

  function onCaptionMessage(caption, metadata) {
    if (!caption || isNullish(caption.deviceSpace) || isNullish(caption.captionId)) return;

    const updatedAtMs = receivedAt(metadata);
    const now = Date.now();
    const fingerprint = finalizedCaptionFingerprint(caption);
    pruneRecentlyFinalized(now);
    if (recentlyFinalized.has(fingerprint)) return;
    pruneRecentlyFinalizedGroupedCaptionIds(now);
    if (recentlyFinalizedGroupedCaptionIds.has(groupedCaptionIdFingerprint(caption.deviceSpace, caption.captionId))) return;
    let group = captionGroups.get(caption.deviceSpace);
    if (!group) {
      group = {
        deviceSpace: caption.deviceSpace,
        leaderCaptionId: caption.captionId,
        entries: new Map(),
        finalizationGraceTimer: null,
      };
      captionGroups.set(caption.deviceSpace, group);
    }
    let entry = group.entries.get(caption.captionId);

    if (!entry) {
      entry = {
        schema: caption.schema,
        captionId: caption.captionId,
        deviceSpace: caption.deviceSpace,
        firstReceivedAtMs: updatedAtMs,
        lastUpdatedAtMs: updatedAtMs,
        version: caption.version,
        lastSeenVersion: caption.version,
        text: caption.text,
        isFinal: caption.isFinal,
        isComplete: false,
        inactivityTimer: null,
      };
      group.entries.set(caption.captionId, entry);
    } else {
      if (entry.isComplete) return;
      if (caption.version < entry.lastSeenVersion) return;
      entry.lastSeenVersion = caption.version;
      entry.version = caption.version;
      entry.schema = caption.schema;
      entry.lastUpdatedAtMs = updatedAtMs;
      entry.text = caption.text;
      entry.isFinal = caption.isFinal;
    }

    if (caption.isFinal === true) {
      completeEntry(group, entry);
    } else if (caption.schema === "v1") {
      scheduleV1Finalization(group, entry);
    } else if (entry.inactivityTimer !== null) {
      // A v2 revision must not inherit a v1 idle timer for the same key.
      clearTimeout(entry.inactivityTimer);
      entry.inactivityTimer = null;
    }
  }

  function flush() {
    for (const group of [...captionGroups.values()]) finalizeGroup(group);
  }

  function reset() {
    for (const group of captionGroups.values()) {
      if (group.finalizationGraceTimer !== null) clearTimeout(group.finalizationGraceTimer);
      for (const entry of group.entries.values()) {
        if (entry.inactivityTimer !== null) clearTimeout(entry.inactivityTimer);
      }
    }
    captionGroups.clear();
  }

  return { onCaptionMessage, flush, reset };
}
