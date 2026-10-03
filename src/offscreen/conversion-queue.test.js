import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversionQueue, retryDelay } from "./conversion-queue.js";
const job = (id, overrides = {}) => ({ sessionId: id, stream: "meeting", attempts: 0, state: "waiting", createdAt: 0, nextAttemptAt: 0, ...overrides });
const handlers = () => ({ save: vi.fn().mockResolvedValue(), input: vi.fn().mockResolvedValue({ inputs: [new Uint8Array([1])] }), publish: vi.fn().mockResolvedValue(), finish: vi.fn().mockResolvedValue() });
afterEach(() => vi.useRealTimers());
describe("durable conversion scheduling", () => {
  it("runs B while A waits, reloads inputs on retry, and serializes workers", async () => {
    vi.useFakeTimers(); const order = [];
    const attempt = vi.fn().mockImplementationOnce(async () => { order.push("A1"); throw new Error("temporary"); })
      .mockImplementationOnce(async () => { order.push("B"); return new Uint8Array([2]); })
      .mockImplementationOnce(async () => { order.push("A2"); return new Uint8Array([3]); });
    const queue = new ConversionQueue({ attempt, now: () => Date.now() });
    const a = job("A"), b = job("B"); const ah = handlers(), bh = handlers();
    await queue.add(a, ah); await queue.add(b, bh); await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["A1", "B"]); expect(a.state).toBe("waiting"); expect(b.state).toBe("succeeded");
    await vi.advanceTimersByTimeAsync(retryDelay(1));
    expect(order).toEqual(["A1", "B", "A2"]); expect(ah.input).toHaveBeenCalledTimes(2);
    expect(queue.snapshot()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("counts an interrupted attempt and stops after ten total attempts", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockRejectedValue(new Error("RUN_TIMEOUT"));
    const queue = new ConversionQueue({ attempt }); const restored = job("restored", { state: "running", attempts: 9 });
    const h = handlers(); await queue.add(restored, h); await vi.advanceTimersByTimeAsync(0);
    expect(restored).toMatchObject({ attempts: 10, state: "failed" });
    expect(attempt).toHaveBeenCalledOnce(); expect(h.finish).toHaveBeenCalledOnce();
  });
  it("does not execute a restored exhausted attempt or publish obsolete results", async () => {
    vi.useFakeTimers(); const queue = new ConversionQueue({ attempt: vi.fn(async () => new Uint8Array([1])) });
    const h = handlers(), exhausted = job("old", { state: "running", attempts: 10 });
    await queue.add(exhausted, h); expect(queue.attempt).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledOnce();
    let release; queue.attempt = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const current = job("current"); await queue.add(current, h); await vi.advanceTimersByTimeAsync(0);
    current.attemptId = "cancelled"; release(new Uint8Array([1])); await vi.advanceTimersByTimeAsync(0);
    expect(h.publish).not.toHaveBeenCalled(); clearTimeout(queue.timer);
  });
});

it("aborts the whole job including preparation and prevents its late publication", async () => {
  vi.useFakeTimers();
  const h = handlers(); let release;
  h.input.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const attempt = vi.fn().mockResolvedValue(new Uint8Array([1])), queue = new ConversionQueue({ attempt });
  const pending = job("late"); await queue.add(pending, h); await vi.advanceTimersByTimeAsync(120000);
  expect(pending.state).toBe("waiting"); release({ inputs: [new Uint8Array([1])] }); await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).not.toHaveBeenCalled(); clearTimeout(queue.timer); vi.useRealTimers();
});

it("restores terminal jobs whose result metadata was not published without re-encoding", async () => {
  vi.useFakeTimers(); const attempt = vi.fn(), queue = new ConversionQueue({ attempt });
  const h = handlers(), restored = job("done", { state: "succeeded", attempts: 1, published: false });
  await queue.add(restored, h); await vi.advanceTimersByTimeAsync(0);
  expect(attempt).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledOnce(); expect(restored.published).toBe(true);
  expect(queue.snapshot()).toEqual([]); vi.useRealTimers();
});
