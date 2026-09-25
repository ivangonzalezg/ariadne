const MAX_BUFFER_ENTRIES = 200;
const RAW_CAPTURE_LABELS = new Set(["collections", "dcrpc"]);
const MAX_RAW_MESSAGES_PER_LABEL = 20;
const MAX_RAW_PAYLOAD_BYTES = 2 * 1024;
let rosterSpikeDiagnosticsController = null;

function messageByteLength(data) {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  return null;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function payloadToBase64(data) {
  if (data instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(data, 0, Math.min(data.byteLength, MAX_RAW_PAYLOAD_BYTES)));
  if (ArrayBuffer.isView(data)) {
    return bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, MAX_RAW_PAYLOAD_BYTES)));
  }
  if (typeof data === "string") return bytesToBase64(new TextEncoder().encode(data).subarray(0, MAX_RAW_PAYLOAD_BYTES));
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => bytesToBase64(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, MAX_RAW_PAYLOAD_BYTES))));
  }
  return null;
}

/**
 * Temporary, metadata-only instrumentation for the Meet roster spike.
 *
 * This deliberately wraps createDataChannel separately from
 * caption-datachannel-patch.js. The caption patch owns decoding only the two
 * known caption labels; extending it to every channel would couple the
 * temporary roster investigation to production caption processing. Chaining
 * preserves both wrappers and lets this probe observe every label.
 */
export function installRosterSpikeDiagnostics({
  isEnabled = () => false,
  isRawCaptureEnabled = () => false,
  log = (...args) => console.debug(...args),
  maxBufferEntries = MAX_BUFFER_ENTRIES,
} = {}) {
  if (rosterSpikeDiagnosticsController) return rosterSpikeDiagnosticsController;
  if (!window.RTCPeerConnection) return null;

  const PeerConnection = window.RTCPeerConnection;
  const originalCreateDataChannel = PeerConnection.prototype.createDataChannel;
  if (!originalCreateDataChannel) return null;

  // Keep only metadata, even while disabled, so channels created before the
  // user starts recording remain available after the explicit flag is enabled.
  // A 200-entry ring buffer bounds both memory and the diagnostic surface.
  const buffer = [];
  const observedChannels = new WeakSet();
  let enabled = Boolean(isEnabled());
  let rawCaptureEnabled = Boolean(isRawCaptureEnabled());
  const rawMessageCountByLabel = new Map();

  const push = (event, details) => {
    const entry = { event, ...details };
    buffer.push(entry);
    if (buffer.length > maxBufferEntries) buffer.shift();
    if (enabled) log(`[Ariadne:roster-spike] ${event}`, details);
    return entry;
  };

  const observeChannel = (channel, direction) => {
    if (!channel || observedChannels.has(channel)) return;
    observedChannels.add(channel);

    const createdAtMs = Date.now();
    const channelLabel = channel.label ?? null;
    let messageCount = 0;
    let firstMessageAtMs = null;

    push("datachannel-created", {
      channelLabel,
      direction,
      readyState: channel.readyState ?? null,
      createdAtMs,
      messageCount,
      firstMessageAtMs,
    });

    channel.addEventListener?.("message", (event) => {
      const receivedAtMs = Date.now();
      messageCount += 1;
      if (firstMessageAtMs === null) firstMessageAtMs = receivedAtMs;
      // Do not retain, decode, stringify, or otherwise inspect event.data.
      const byteLength = messageByteLength(event.data);
      const entry = {
        channelLabel,
        direction,
        readyState: channel.readyState ?? null,
        createdAtMs,
        messageCount,
        byteLength,
        firstMessageAtMs,
      };
      const bufferedEntry = push("datachannel-message-received", entry);

      if (!enabled || !rawCaptureEnabled || !RAW_CAPTURE_LABELS.has(channelLabel)) return;
      const rawMessageCount = rawMessageCountByLabel.get(channelLabel) ?? 0;
      if (rawMessageCount >= MAX_RAW_MESSAGES_PER_LABEL) return;
      rawMessageCountByLabel.set(channelLabel, rawMessageCount + 1);

      const base64 = payloadToBase64(event.data);
      if (typeof base64 === "string") {
        bufferedEntry.payloadBase64 = base64;
      } else if (base64) {
        base64.then((payloadBase64) => {
          bufferedEntry.payloadBase64 = payloadBase64;
        }).catch(() => {});
      }
    });
  };

  PeerConnection.prototype.createDataChannel = function (...args) {
    const channel = originalCreateDataChannel.apply(this, args);
    observeChannel(channel, "outgoing");
    return channel;
  };

  // This constructor wrapper is intentionally chained after rtc-patch.js's
  // wrapper. The latter still owns audio lifecycle handling; this one only
  // attaches the missing incoming data-channel observer to the same instance.
  function RosterDiagnosticsPeerConnection(...args) {
    const pc = new PeerConnection(...args);
    pc.addEventListener?.("datachannel", (event) => observeChannel(event.channel, "incoming"));
    return pc;
  }
  RosterDiagnosticsPeerConnection.prototype = PeerConnection.prototype;
  Object.setPrototypeOf(RosterDiagnosticsPeerConnection, PeerConnection);
  window.RTCPeerConnection = RosterDiagnosticsPeerConnection;

  rosterSpikeDiagnosticsController = {
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
    },
    setRawCaptureEnabled(nextEnabled) {
      rawCaptureEnabled = Boolean(nextEnabled);
    },
    exportBuffer() {
      if (!enabled) return [];
      const snapshot = buffer.map((entry) => {
        const copy = { ...entry };
        if (!rawCaptureEnabled) delete copy.payloadBase64;
        return copy;
      });
      console.table(snapshot);
      console.log(
        rawCaptureEnabled
          ? "[Ariadne:roster-spike] raw-capture diagnostic buffer"
          : "[Ariadne:roster-spike] metadata-only diagnostic buffer",
        snapshot
      );
      return snapshot;
    },
    getBuffer() {
      return buffer.map((entry) => ({ ...entry }));
    },
  };
  return rosterSpikeDiagnosticsController;
}

export { MAX_BUFFER_ENTRIES, MAX_RAW_MESSAGES_PER_LABEL, MAX_RAW_PAYLOAD_BYTES };
