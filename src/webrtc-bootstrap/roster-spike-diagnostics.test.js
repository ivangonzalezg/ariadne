import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = "connecting";
    this.listeners = {};
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  dispatchMessage(data) {
    for (const listener of this.listeners.message ?? []) listener({ data });
  }
}

class FakePeerConnection {
  constructor() {
    this.listeners = {};
  }

  createDataChannel(label) {
    return new FakeDataChannel(label);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  dispatchDataChannel(channel) {
    for (const listener of this.listeners.datachannel ?? []) listener({ channel });
  }
}

const originalCreateDataChannel = FakePeerConnection.prototype.createDataChannel;
let originalRTCPeerConnection;

beforeEach(() => {
  originalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.prototype.createDataChannel = originalCreateDataChannel;
});

afterEach(() => {
  window.RTCPeerConnection = originalRTCPeerConnection;
  vi.restoreAllMocks();
});

describe("installRosterSpikeDiagnostics", () => {
  it("does not log metadata while the separate diagnostic flag is off", async () => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const log = vi.fn();
    installRosterSpikeDiagnostics({ log });

    const pc = new window.RTCPeerConnection();
    pc.createDataChannel("roster").dispatchMessage("private message");
    pc.dispatchDataChannel(new FakeDataChannel("remote-roster"));

    expect(log).not.toHaveBeenCalled();
  });

  it("logs metadata for outgoing and incoming channels without message contents", async () => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const log = vi.fn();
    installRosterSpikeDiagnostics({ isEnabled: () => true, log });

    const pc = new window.RTCPeerConnection();
    const outgoing = pc.createDataChannel("roster");
    outgoing.dispatchMessage("real person name must never appear");
    const incoming = new FakeDataChannel("remote-roster");
    pc.dispatchDataChannel(incoming);
    incoming.dispatchMessage(new Uint8Array([1, 2, 3]).buffer);

    const serializedLogs = JSON.stringify(log.mock.calls);
    expect(serializedLogs).not.toContain("real person name");
    expect(log).toHaveBeenCalledWith("[Ariadne:roster-spike] datachannel-created", expect.objectContaining({
      channelLabel: "roster",
      direction: "outgoing",
      readyState: "connecting",
      createdAtMs: expect.any(Number),
    }));
    expect(log).toHaveBeenCalledWith("[Ariadne:roster-spike] datachannel-message-received", expect.objectContaining({
      direction: "outgoing",
      messageCount: 1,
      byteLength: new TextEncoder().encode("real person name must never appear").byteLength,
      firstMessageAtMs: expect.any(Number),
    }));
    expect(log).toHaveBeenCalledWith("[Ariadne:roster-spike] datachannel-created", expect.objectContaining({
      channelLabel: "remote-roster",
      direction: "incoming",
    }));
    expect(log).toHaveBeenCalledWith("[Ariadne:roster-spike] datachannel-message-received", expect.objectContaining({
      direction: "incoming",
      byteLength: 3,
    }));
  });

  it("keeps the metadata buffer within its configured limit", async () => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const diagnostics = installRosterSpikeDiagnostics({ maxBufferEntries: 3 });
    const channel = new window.RTCPeerConnection().createDataChannel("roster");
    channel.dispatchMessage(new Uint8Array([1]).buffer);
    channel.dispatchMessage(new Uint8Array([2]).buffer);
    channel.dispatchMessage(new Uint8Array([3]).buffer);

    const entries = diagnostics.getBuffer();
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.event === "datachannel-message-received")).toBe(true);
  });

  it("exports metadata without raw bytes while raw capture is off", async () => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const diagnostics = installRosterSpikeDiagnostics({ isEnabled: () => true });
    const channel = new window.RTCPeerConnection().createDataChannel("collections");
    channel.dispatchMessage(new Uint8Array([1, 2, 3]).buffer);

    const exported = diagnostics.exportBuffer();
    expect(exported).toHaveLength(2);
    expect(exported.every((entry) => !("payloadBase64" in entry))).toBe(true);
  });

  it("does not capture raw bytes unless metadata diagnostics are also enabled", async () => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const diagnostics = installRosterSpikeDiagnostics({ isRawCaptureEnabled: () => true });
    const channel = new window.RTCPeerConnection().createDataChannel("collections");
    channel.dispatchMessage(new Uint8Array([1, 2, 3]).buffer);

    diagnostics.setEnabled(true);
    expect(diagnostics.getBuffer().every((entry) => !("payloadBase64" in entry))).toBe(true);
  });

  it.each(["collections", "dcrpc"])("exports base64 raw bytes for the approved %s label", async (label) => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const diagnostics = installRosterSpikeDiagnostics({
      isEnabled: () => true,
      isRawCaptureEnabled: () => true,
    });
    const channel = new window.RTCPeerConnection().createDataChannel(label);
    channel.dispatchMessage(new Uint8Array([0, 1, 2]).buffer);

    const message = diagnostics.exportBuffer().find((entry) => entry.event === "datachannel-message-received");
    expect(message).toMatchObject({
      channelLabel: label,
      direction: "outgoing",
      byteLength: 3,
      payloadBase64: "AAEC",
    });
  });

  it.each(["media-session", "captions"])("never captures raw bytes for non-approved %s labels", async (label) => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const diagnostics = installRosterSpikeDiagnostics({
      isEnabled: () => true,
      isRawCaptureEnabled: () => true,
    });
    const channel = new window.RTCPeerConnection().createDataChannel(label);
    channel.dispatchMessage(new Uint8Array([1, 2, 3]).buffer);

    expect(diagnostics.exportBuffer().every((entry) => !("payloadBase64" in entry))).toBe(true);
  });

  it("captures at most 20 raw messages per approved label while retaining all metadata", async () => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const diagnostics = installRosterSpikeDiagnostics({
      isEnabled: () => true,
      isRawCaptureEnabled: () => true,
    });
    const channel = new window.RTCPeerConnection().createDataChannel("dcrpc");
    for (let index = 0; index < 21; index += 1) {
      channel.dispatchMessage(new Uint8Array([index]).buffer);
    }

    const messages = diagnostics.exportBuffer().filter((entry) => entry.event === "datachannel-message-received");
    expect(messages).toHaveLength(21);
    expect(messages.filter((entry) => "payloadBase64" in entry)).toHaveLength(20);
    expect(messages[20]).not.toHaveProperty("payloadBase64");
  });

  it("truncates an oversized raw payload to its first 2KB without dropping its metadata", async () => {
    vi.resetModules();
    const { installRosterSpikeDiagnostics } = await import("./roster-spike-diagnostics.js");
    const diagnostics = installRosterSpikeDiagnostics({
      isEnabled: () => true,
      isRawCaptureEnabled: () => true,
    });
    const bytes = new Uint8Array(2049).fill(7);
    const channel = new window.RTCPeerConnection().createDataChannel("collections");
    channel.dispatchMessage(bytes.buffer);

    const message = diagnostics.exportBuffer().find((entry) => entry.event === "datachannel-message-received");
    expect(message).toMatchObject({ byteLength: 2049 });
    expect(message.payloadBase64).toBe(btoa(String.fromCharCode(...bytes.subarray(0, 2048))));
  });
});
