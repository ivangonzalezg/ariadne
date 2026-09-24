import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeGunzip: vi.fn(),
  decodeCaptionV1: vi.fn(),
  decodeCaptionV2: vi.fn(),
}));

vi.mock("../lib/gzip-inflate.js", () => ({ maybeGunzip: mocks.maybeGunzip }));
vi.mock("../lib/caption-protobuf-decoder.js", () => ({
  decodeCaptionV1: mocks.decodeCaptionV1,
  decodeCaptionV2: mocks.decodeCaptionV2,
}));

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = "connecting";
    this._listeners = {};
  }

  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }

  dispatch(data) {
    (this._listeners.message ?? []).forEach((handler) => handler({ data }));
  }
}

class FakePeerConnection {
  constructor() {
    this.connectionState = "new";
  }

  addEventListener() {}

  createDataChannel(label) {
    return new FakeDataChannel(label);
  }
}

const originalCreateDataChannel = FakePeerConnection.prototype.createDataChannel;

const decodedCaption = {
  schema: "v2",
  captionId: 42,
  version: 3,
  text: "texto privado de fixture",
  isFinal: true,
  deviceSpace: "device-1",
  languageId: null,
  timestampSeconds: 123,
};

async function flushMessageHandler() {
  await Promise.resolve();
  await Promise.resolve();
}

let originalRTCPeerConnection;

beforeEach(() => {
  originalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.prototype.createDataChannel = originalCreateDataChannel;
  mocks.maybeGunzip.mockReset();
  mocks.decodeCaptionV1.mockReset();
  mocks.decodeCaptionV2.mockReset();
});

afterEach(() => {
  window.RTCPeerConnection = originalRTCPeerConnection;
  vi.restoreAllMocks();
});

describe("installCaptionsDataChannelPatch", () => {
  it.each([
    ["captions", "decodeCaptionV1"],
    ["captions_v2", "decodeCaptionV2"],
  ])("captures messages from %s with its matching decoder", async (label, decoderName) => {
    vi.resetModules();
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    const onCaptionMessage = vi.fn();
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.maybeGunzip.mockResolvedValue(bytes);
    mocks.decodeCaptionV1.mockReturnValue(decodedCaption);
    mocks.decodeCaptionV2.mockReturnValue(decodedCaption);
    installCaptionsDataChannelPatch({ onCaptionMessage });

    const channel = new window.RTCPeerConnection().createDataChannel(label);
    channel.dispatch(bytes.buffer);
    await flushMessageHandler();

    expect(mocks[decoderName]).toHaveBeenCalledWith(bytes);
    expect(onCaptionMessage).toHaveBeenCalledWith(decodedCaption, {
      channelLabel: label,
      receivedAtMs: expect.any(Number),
    });
  });

  it("leaves non-caption channels untouched", async () => {
    vi.resetModules();
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    installCaptionsDataChannelPatch({ onCaptionMessage: vi.fn() });

    const channel = new window.RTCPeerConnection().createDataChannel("chat");

    expect(channel).toBeInstanceOf(FakeDataChannel);
    expect(channel._listeners.message).toBeUndefined();
  });

  it("reports whether a caption channel came from a patched peer connection and counts unmarked ones", async () => {
    vi.resetModules();
    const { installRtcPatch, diagnostics } = await import("./rtc-patch.js");
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    installRtcPatch({ onRemoteAudioTrack: () => {}, onConnectionClosed: () => {} });
    installCaptionsDataChannelPatch({ onCaptionMessage: vi.fn() });

    new window.RTCPeerConnection().createDataChannel("captions");
    new FakePeerConnection().createDataChannel("captions_v2");

    expect(info).toHaveBeenNthCalledWith(1,
      "[Asterion:rtc-patch] caption-datachannel-peer-connection-marker",
      { channelLabel: "captions", patchedPeerConnection: true });
    expect(info).toHaveBeenNthCalledWith(2,
      "[Asterion:rtc-patch] caption-datachannel-peer-connection-marker",
      { channelLabel: "captions_v2", patchedPeerConnection: false });
    expect(diagnostics.unmarkedCaptionDataChannels).toBe(1);
  });

  it("discards a message when gzip inflation fails", async () => {
    vi.resetModules();
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    const onCaptionMessage = vi.fn();
    mocks.maybeGunzip.mockResolvedValue(null);
    installCaptionsDataChannelPatch({ onCaptionMessage });

    new window.RTCPeerConnection().createDataChannel("captions").dispatch(new Uint8Array([1]).buffer);
    await flushMessageHandler();

    expect(mocks.decodeCaptionV1).not.toHaveBeenCalled();
    expect(onCaptionMessage).not.toHaveBeenCalled();
  });

  it("discards a message when its caption decoder returns null", async () => {
    vi.resetModules();
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    const onCaptionMessage = vi.fn();
    mocks.maybeGunzip.mockResolvedValue(new Uint8Array([1]));
    mocks.decodeCaptionV1.mockReturnValue(null);
    installCaptionsDataChannelPatch({ onCaptionMessage });

    new window.RTCPeerConnection().createDataChannel("captions").dispatch(new Uint8Array([1]).buffer);
    await flushMessageHandler();

    expect(onCaptionMessage).not.toHaveBeenCalled();
  });

  it("discards non-binary caption-channel messages before inflation", async () => {
    vi.resetModules();
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    const onCaptionMessage = vi.fn();
    installCaptionsDataChannelPatch({ onCaptionMessage });

    new window.RTCPeerConnection().createDataChannel("captions").dispatch("not binary");
    await flushMessageHandler();

    expect(mocks.maybeGunzip).not.toHaveBeenCalled();
    expect(onCaptionMessage).not.toHaveBeenCalled();
  });

  it("does not wrap createDataChannel twice", async () => {
    vi.resetModules();
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    const onCaptionMessage = vi.fn();
    mocks.maybeGunzip.mockResolvedValue(new Uint8Array([1]));
    mocks.decodeCaptionV1.mockReturnValue(decodedCaption);
    installCaptionsDataChannelPatch({ onCaptionMessage });
    const patchedCreateDataChannel = window.RTCPeerConnection.prototype.createDataChannel;
    installCaptionsDataChannelPatch({ onCaptionMessage: vi.fn() });

    const channel = new window.RTCPeerConnection().createDataChannel("captions");
    channel.dispatch(new Uint8Array([1]).buffer);
    await flushMessageHandler();

    expect(window.RTCPeerConnection.prototype.createDataChannel).toBe(patchedCreateDataChannel);
    expect(onCaptionMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps decoded caption text out of all logs", async () => {
    vi.resetModules();
    const { installCaptionsDataChannelPatch } = await import("./caption-datachannel-patch.js");
    const logs = [];
    mocks.maybeGunzip.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mocks.decodeCaptionV2.mockReturnValue(decodedCaption);
    installCaptionsDataChannelPatch({
      onCaptionMessage: vi.fn(),
      log: (...args) => logs.push(args),
    });

    const channel = new window.RTCPeerConnection().createDataChannel("captions_v2");
    channel.dispatch(new Uint8Array([1, 2, 3]).buffer);
    await flushMessageHandler();

    expect(JSON.stringify(logs)).not.toContain(decodedCaption.text);
  });
});
