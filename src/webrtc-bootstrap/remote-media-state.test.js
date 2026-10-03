import { afterEach, describe, expect, it, vi } from "vitest";
import { Blob as NativeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { decodeMediaStates, RemoteMediaState } from "./remote-media-state.js";
const text = (s) => [...new TextEncoder().encode(s)];
const field = (id, value) => typeof value === "number" ? [id * 8, value] : [id * 8 + 2, value.length, ...value];
const message = ({ ssrc = "42", muted = 0, deviceId = "participant" } = {}) => new Uint8Array(field(1, field(2, field(3, field(2, [
  ...field(2, 1), ...field(4, text(ssrc)), ...field(6, text(deviceId)), ...(muted === null ? [] : field(10, field(1, muted))),
])))));
afterEach(() => vi.unstubAllGlobals());
describe("announced remote media state", () => {
  it("maps media state to receiver synchronization sources and preserves partial updates", async () => {
    const state = new RemoteMediaState();
    const receiver = { getSynchronizationSources: () => [{ source: 42 }] };
    expect(state.get(receiver)).toBeNull();
    expect(decodeMediaStates(message())).toEqual([{ type: 1, ssrc: "42", deviceId: "participant", muted: 0 }]);
    await state.receive(message()); expect(state.get(receiver)).toBe(true);
    await state.receive(message({ ssrc: "", muted: 1 })); expect(state.get(receiver)).toBe(false);
    await state.receive(message({ muted: null })); expect(state.get(receiver)).toBe(false);
    expect(state.get({ getSynchronizationSources: () => { throw new Error("unavailable"); } })).toBeNull();
  });
  it("keeps malformed and unavailable metadata unknown and observes each eligible channel once", async () => {
    const log = vi.fn(), state = new RemoteMediaState({ log });
    await state.receive(new Uint8Array([10, 20, 1]));
    expect(log).toHaveBeenCalledWith("remote-media-state-unavailable", expect.any(Object));
    const channel = { label: "collections", addEventListener: vi.fn() };
    state.observe(channel); state.observe(channel); state.observe({ label: "chat", addEventListener: vi.fn() });
    expect(channel.addEventListener).toHaveBeenCalledOnce();
    expect(state.get({ getSynchronizationSources: () => [{ source: 42 }] })).toBeNull();
  });
  it("decodes compressed announcements and excludes child devices identified by the roster", async () => {
    vi.stubGlobal("Blob", NativeBlob);
    const state = new RemoteMediaState(), receiver = { getSynchronizationSources: () => [{ source: 42 }] };
    // Use an exact view because Node's pooled buffers may contain unrelated bytes.
    const compressed = gzipSync(message()); await state.receive(new Uint8Array(compressed));
    expect(state.get(receiver)).toBe(true);
    const user = [...field(1, text("participant")), 170, 1, 6, ...text("parent")];
    await state.receive(new Uint8Array(field(1, field(2, field(13, field(1, field(2, user)))))));
    expect(state.get(receiver)).toBeNull();
  });

});
