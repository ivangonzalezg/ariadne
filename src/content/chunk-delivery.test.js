import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkDelivery } from "./chunk-delivery.js";
const chunk = (seq, stream = "meeting") => ({ type: "asterion:chunk", sessionId: "session", stream, generation: 0, seq, captureTs: seq, buffer: new Uint8Array([seq]).buffer });
function setup(send) {
  vi.useFakeTimers();
  const onAck = vi.fn(), onFatal = vi.fn(), recover = vi.fn().mockResolvedValue();
  const delivery = new ChunkDelivery({ sessionId: "session", send, recover, onAck, onFatal });
  return { delivery, recover, onAck, onFatal };
}
afterEach(() => vi.useRealTimers());
describe("unacknowledged capture fragments", () => {
  it("retains n while n+1 commits, then retransmits n after a transport restore", async () => {
    let fail = true;
    const send = vi.fn(async (message) => message.seq === 1 && fail ? { error: "transport", retryable: true } : { committed: true, durable: true, seq: message.seq });
    const { delivery, recover, onAck } = setup(send);
    delivery.add(chunk(1)); delivery.add(chunk(2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onAck).toHaveBeenCalledOnce(); expect(delivery.pending.size).toBe(1);
    fail = false; await vi.advanceTimersByTimeAsync(10000);
    expect(recover).toHaveBeenCalledOnce(); expect(delivery.pending.size).toBe(0);
    expect(onAck.mock.calls.map(([message]) => message.seq)).toEqual([2, 1]);
    await delivery.flush(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retries a lost ACK with the same identity and counts progress per session", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("ACK lost")).mockResolvedValue({ committed: true, durable: true, duplicate: true });
    const { delivery, onAck } = setup(send); delivery.add(chunk(1));
    await vi.advanceTimersByTimeAsync(201);
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]); expect(onAck).toHaveBeenCalledOnce();
    await delivery.flush();
  });
  it("stops on a definitive failure while keeping the final fragment and uncommitted records", async () => {
    const send = vi.fn().mockResolvedValue({ error: "Quota exhausted", retryable: false });
    const { delivery, onFatal } = setup(send); delivery.add(chunk(1)); await vi.advanceTimersByTimeAsync(0);
    expect(onFatal).toHaveBeenCalledOnce(); delivery.add(chunk(2));
    const errors = await delivery.flush();
    expect(errors).toHaveLength(2); expect(delivery.pending.size).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds recoveries after prior commits rather than relying on a lifetime commit count", async () => {
    const send = vi.fn().mockResolvedValueOnce({ committed: true, durable: true }).mockRejectedValue(new Error("transport"));
    const { delivery, recover, onFatal } = setup(send); delivery.add(chunk(1)); await vi.advanceTimersByTimeAsync(0);
    delivery.add(chunk(2)); await vi.advanceTimersByTimeAsync(31000);
    expect(recover).toHaveBeenCalledTimes(2); expect(onFatal).toHaveBeenCalledOnce();
    const flushed = delivery.flush(); await vi.advanceTimersByTimeAsync(1000); await flushed;
  });
  it("enforces 128 MiB even if transport is still running", async () => {
    const send = vi.fn().mockResolvedValue({ committed: true, durable: true }); const { delivery, onFatal } = setup(send);
    delivery.add({ ...chunk(1), buffer: { byteLength: 128 * 1024 * 1024 + 1 } });
    expect(onFatal).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0); await delivery.flush();
  });
});

it("enforces the age limit even while an offscreen reconstruction is hung", async () => {
  vi.useFakeTimers(); const onFatal = vi.fn();
  const delivery = new ChunkDelivery({ sessionId: "session", send: vi.fn().mockRejectedValue(new Error("transport")),
    recover: () => new Promise(() => {}), onAck: vi.fn(), onFatal });
  delivery.add(chunk(1)); await vi.advanceTimersByTimeAsync(31000);
  expect(onFatal).toHaveBeenCalledOnce(); expect(delivery.recoveries).toBeLessThanOrEqual(2);
  const flushed = delivery.flush(); await vi.advanceTimersByTimeAsync(1000); await flushed; vi.useRealTimers();
});
