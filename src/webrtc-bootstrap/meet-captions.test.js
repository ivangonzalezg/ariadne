import { afterEach, describe, expect, it, vi } from "vitest";
import { Blob as NativeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { MeetCaptions } from "./meet-captions.js";
import { decodeCaption } from "./caption-decoder.js";
import { meetMessageBytes } from "../lib/proto-wire.js";
import { oldCaption, v2Caption, roster } from "../../tests/helpers/meet-protobuf.js";
let service;
afterEach(async () => { await service?.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function channel(label) {
  const value = new EventTarget(); Object.assign(value, { label, readyState: "open", close: vi.fn() }); return value;
}
function setup(mode = "hybrid") {
  const onCaption = vi.fn(), onStatus = vi.fn(), log = vi.fn();
  service = new MeetCaptions({ onCaption, onStatus, log });
  service.start("s", mode); return { onCaption, onStatus, log };
}
async function send(target, bytes) {
  target.dispatchEvent(new MessageEvent("message", { data: bytes })); await Promise.all([...service.tasks]);
}
describe("Meet caption protocol", () => {
  it("decodes both formats, retaining large IDs and finality/language/timestamp", () => {
    expect(decodeCaption(oldCaption(9007199254740993n), "captions").utteranceId).toContain("9007199254740993");
    expect(decodeCaption(v2Caption(), "captions_v2")).toMatchObject({ text: "Hola", language: "es", isFinal: true, protocolTimestamp: 123 });
  });
  it("accepts first speech after five minutes, rejects stale revisions, fills a missing name retroactively", async () => {
    vi.useFakeTimers(); const { onCaption } = setup(); const cc = channel("captions"), users = channel("collections");
    service.observe(cc); service.observe(users); await vi.advanceTimersByTimeAsync(300000);
    await send(cc, oldCaption(1, 1)); await send(cc, oldCaption(1, 2, "Hola a todos"));
    await send(cc, oldCaption(1, 1)); await send(cc, oldCaption(1, 2));
    expect(onCaption).toHaveBeenCalledTimes(2); expect(onCaption.mock.calls[0][0].speaker).toBeNull();
    await send(users, roster());
    expect(onCaption.mock.calls.at(-1)[0]).toMatchObject({ speaker: "Ana", revision: 3, text: "Hola a todos" });
    expect(service.utterances.size).toBe(1);
  });
  it("reads gzip v2 and reports incompatible packets without throwing into audio", async () => {
    vi.stubGlobal("Blob", NativeBlob); const { onCaption, log } = setup(); const cc = channel("captions_v2"); service.observe(cc);
    await send(cc, new Uint8Array(gzipSync(v2Caption())));
    expect(onCaption.mock.calls[0][0]).toMatchObject({ language: "es", isFinal: true });
    await send(cc, new Uint8Array([10, 255]));
    expect(log).toHaveBeenCalledWith("caption-decode-error", expect.any(Object));
  });
  it("bounds compressed and decompressed messages", async () => {
    vi.stubGlobal("Blob", NativeBlob);
    await expect(meetMessageBytes(new Uint8Array(1048577))).rejects.toThrow("too large");
    await expect(meetMessageBytes(new Uint8Array(gzipSync(new Uint8Array(1048577))))).rejects.toThrow("too large");
  });
  it("recreates a closed channel after reconnect, for either caption format", async () => {
    vi.useFakeTimers(); setup();
    const pc = { connectionState: "connected", createDataChannel: vi.fn(label => channel(label)) };
    const cc = channel("captions_v2"); service.observe(cc, { pc, connectionId: 1 });
    pc.connectionState = "disconnected"; cc.readyState = "closed";
    await vi.advanceTimersByTimeAsync(2000); expect(pc.createDataChannel).not.toHaveBeenCalled();
    pc.connectionState = "connected"; await vi.advanceTimersByTimeAsync(1000);
    expect(pc.createDataChannel).toHaveBeenCalledWith("captions_v2", expect.any(Object));
  });
  it("drains already received messages on stop but rejects new and previous-session input", async () => {
    const { onCaption } = setup(); const cc = channel("captions"); service.observe(cc);
    cc.dispatchEvent(new MessageEvent("message", { data: oldCaption() }));
    await service.stop(); expect(onCaption).toHaveBeenCalledOnce();
    await send(cc, oldCaption(2)); expect(onCaption).toHaveBeenCalledOnce();
    service.start("new", "hybrid"); await send(cc, oldCaption(3));
    expect(onCaption.mock.calls.at(-1)[0].sessionId).toBe("new");
  });
  it("observes channels once and does not decode or create channels in DOM mode", async () => {
    const { onCaption } = setup("dom"); const cc = channel("captions");
    service.observe(cc); service.observe(cc); await send(cc, oldCaption()); expect(onCaption).not.toHaveBeenCalled();
    expect(service.channels.size).toBe(1);
  });
});

it("uses roster metadata discovered before recording without capturing text before start", async () => {
  const onCaption = vi.fn(); service = new MeetCaptions({ onCaption });
  service.updateParticipant({ speakerId: "ana", speaker: "Ana" });
  const cc = channel("captions"); service.observe(cc); await send(cc, oldCaption());
  expect(onCaption).not.toHaveBeenCalled();
  service.start("s", "hybrid"); await send(cc, oldCaption());
  expect(onCaption.mock.calls[0][0].speaker).toBe("Ana");
});
