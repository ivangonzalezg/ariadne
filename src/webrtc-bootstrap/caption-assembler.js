const DEFAULT_INACTIVITY_MS = 2000;
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
  finalizedCaptionTtlMs = DEFAULT_FINALIZED_CAPTION_TTL_MS,
  maxFinalizedCaptionFingerprints = DEFAULT_MAX_FINALIZED_CAPTION_FINGERPRINTS,
}) {
  const captions = new Map();
  const recentlyFinalized = new Map();

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

  function finalize(key, entry) {
    if (captions.get(key) !== entry) return;
    if (entry.inactivityTimer !== null) clearTimeout(entry.inactivityTimer);
    captions.delete(key);
    rememberFinalizedCaption(entry);
    onCaptionFinalized({
      captionId: entry.captionId,
      deviceSpace: entry.deviceSpace,
      text: entry.text,
      startMs: entry.firstReceivedAtMs,
      endMs: entry.lastUpdatedAtMs,
    });
  }

  function scheduleV1Finalization(key, entry) {
    if (entry.inactivityTimer !== null) clearTimeout(entry.inactivityTimer);
    entry.inactivityTimer = setTimeout(() => finalize(key, entry), inactivityMs);
  }

  function onCaptionMessage(caption, metadata) {
    if (!caption || isNullish(caption.deviceSpace) || isNullish(caption.captionId)) return;

    const key = `${caption.deviceSpace}:${caption.captionId}`;
    const updatedAtMs = receivedAt(metadata);
    const now = Date.now();
    const fingerprint = finalizedCaptionFingerprint(caption);
    pruneRecentlyFinalized(now);
    if (recentlyFinalized.has(fingerprint)) return;
    let entry = captions.get(key);

    // Entries are removed at finalization, so a later revision deliberately starts
    // a new segment rather than reopening a finalized one.
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
        inactivityTimer: null,
      };
      captions.set(key, entry);
    } else {
      if (caption.version < entry.lastSeenVersion) return;
      entry.lastSeenVersion = caption.version;
      entry.version = caption.version;
      entry.schema = caption.schema;
      entry.lastUpdatedAtMs = updatedAtMs;
      entry.text = caption.text;
      entry.isFinal = caption.isFinal;
    }

    if (caption.isFinal === true) {
      finalize(key, entry);
    } else if (caption.schema === "v1") {
      scheduleV1Finalization(key, entry);
    } else if (entry.inactivityTimer !== null) {
      // A v2 revision must not inherit a v1 idle timer for the same key.
      clearTimeout(entry.inactivityTimer);
      entry.inactivityTimer = null;
    }
  }

  function flush() {
    for (const [key, entry] of [...captions]) finalize(key, entry);
  }

  function reset() {
    for (const entry of captions.values()) {
      if (entry.inactivityTimer !== null) clearTimeout(entry.inactivityTimer);
    }
    captions.clear();
  }

  return { onCaptionMessage, flush, reset };
}
