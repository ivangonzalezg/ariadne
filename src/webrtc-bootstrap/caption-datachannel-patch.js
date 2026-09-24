import { maybeGunzip } from "../lib/gzip-inflate.js";
import { decodeCaptionV1, decodeCaptionV2 } from "../lib/caption-protobuf-decoder.js";
import { diagnostics, isPatchedRtcPeerConnection } from "./rtc-patch.js";

const CAPTION_CHANNELS = new Set(["captions", "captions_v2"]);

let captionsDataChannelPatchInstalled = false;

function toUint8Array(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Observes Meet's caption data channels without changing their data flow.
 * This patch is deliberately idempotent because bootstrap code can be loaded twice.
 */
export function installCaptionsDataChannelPatch({ onCaptionMessage, log = () => {} }) {
  if (captionsDataChannelPatchInstalled) return;
  if (!window.RTCPeerConnection || !window.RTCPeerConnection.prototype.createDataChannel) return;

  captionsDataChannelPatchInstalled = true;
  const originalCreateDataChannel = window.RTCPeerConnection.prototype.createDataChannel;

  window.RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = originalCreateDataChannel.apply(this, args);
    const channelLabel = args[0];

    log("caption-datachannel-created", {
      channelLabel,
      readyState: channel.readyState,
    });

    if (!CAPTION_CHANNELS.has(channelLabel)) return channel;

    const patchedPeerConnection = isPatchedRtcPeerConnection(this);
    // This deliberately bypasses debug logging: it must reveal connections
    // created before a recording session enables debug output.
    console.info("[Asterion:rtc-patch] caption-datachannel-peer-connection-marker", {
      channelLabel,
      patchedPeerConnection,
    });
    if (!patchedPeerConnection) diagnostics.unmarkedCaptionDataChannels += 1;

    let firstMessageReceived = false;
    channel.addEventListener("message", async (event) => {
      const receivedAtMs = Date.now();
      const bytes = toUint8Array(event.data);
      const rawByteLength = bytes?.byteLength ?? null;

      if (!firstMessageReceived) {
        firstMessageReceived = true;
        log("caption-datachannel-first-message-received", {
          channelLabel,
          readyState: channel.readyState,
          rawByteLength,
          receivedAtMs,
        });
      }

      if (!bytes) {
        log("caption-datachannel-message-discarded", {
          channelLabel,
          readyState: channel.readyState,
          rawByteLength,
          receivedAtMs,
          reason: "non-binary",
        });
        return;
      }

      try {
        const inflated = await maybeGunzip(bytes);
        if (inflated === null) {
          log("caption-datachannel-message-discarded", {
            channelLabel,
            readyState: channel.readyState,
            rawByteLength,
            receivedAtMs,
            reason: "inflate-failed",
          });
          return;
        }

        const decoded = channelLabel === "captions"
          ? decodeCaptionV1(inflated)
          : decodeCaptionV2(inflated);
        if (decoded === null) {
          log("caption-datachannel-message-discarded", {
            channelLabel,
            readyState: channel.readyState,
            rawByteLength,
            receivedAtMs,
            reason: "decode-failed",
          });
          return;
        }

        log("caption-datachannel-decoded", {
          channelLabel,
          readyState: channel.readyState,
          rawByteLength,
          receivedAtMs,
          captionId: decoded.captionId,
          version: decoded.version,
          isFinal: decoded.isFinal,
        });
        onCaptionMessage(decoded, { channelLabel, receivedAtMs });
      } catch {
        log("caption-datachannel-message-discarded", {
          channelLabel,
          readyState: channel.readyState,
          rawByteLength,
          receivedAtMs,
          reason: "processing-failed",
        });
      }
    });

    return channel;
  };
}
