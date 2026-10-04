import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptionDelivery } from "./caption-delivery.js";
const snapshot = { source: "dom", utteranceId: "one", revision: 1, text: "Hola", firstReceivedAt: 1, updatedAt: 1, speaker: "Ana" };
let delivery;
afterEach(() => { delivery?.dispose(); vi.useRealTimers(); });
function setup(send, recover = vi.fn().mockResolvedValue({})) {
  vi.useFakeTimers(); const onAck = vi.fn(), onStatus = vi.fn();
  delivery = new CaptionDelivery({ sessionId: "s", send, recover, onAck, onStatus });
  return { onAck, onStatus, recover };
}
describe("caption delivery", () => {
  it("retries lost ACKs with immutable identity and confirms only the matching durable ACK", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("ACK lost")).mockResolvedValue({ durable: true, eventSeq: 1 });
    const { onAck } = setup(send); delivery.add(snapshot);
    await vi.advanceTimersByTimeAsync(201);
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]); expect(onAck).toHaveBeenCalledOnce();
    expect(await delivery.flush()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("waits for the last update before sealing delivery", async () => {
    let release;
    const { onAck } = setup(() => new Promise(resolve => { release = resolve; }));
    delivery.add(snapshot); const flushing = delivery.flush();
    delivery.add({ ...snapshot, revision: 2 });
    expect(delivery.eventSeq).toBe(1); expect(onAck).not.toHaveBeenCalled();
    release({ durable: true, eventSeq: 1 }); await flushing;
    expect(onAck).toHaveBeenCalledOnce();
  });
  it("recovers storage twice, bounds failure at thirty seconds, and keeps pending text", async () => {
    const { recover } = setup(vi.fn().mockRejectedValue(new Error("offline")));
    delivery.add(snapshot); await vi.advanceTimersByTimeAsync(31000);
    expect(recover).toHaveBeenCalledTimes(2); expect(delivery.error).toBeTruthy();
    expect(await delivery.flush()).toHaveLength(1); expect(delivery.pending.size).toBe(1);
  });
  it("retains definitive failures without stopping any audio component", async () => {
    const { onStatus } = setup(vi.fn().mockResolvedValue({ error: "Quota", retryable: false }));
    delivery.add(snapshot); await vi.advanceTimersByTimeAsync(0);
    expect(await delivery.flush()).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ error: "Quota" }));
  });
  it("enforces the deadline during hung transport and recovery", async () => {
    setup(() => new Promise(() => {}), () => new Promise(() => {}));
    delivery.add(snapshot); const flushing = delivery.flush();
    await vi.advanceTimersByTimeAsync(35000);
    expect(await flushing).toHaveLength(1); expect(delivery.recoveries).toBeLessThanOrEqual(2);
  });
});
