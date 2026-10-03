import { Blob } from "node:buffer";
export class MemoryFileHandle {
  constructor(name) { this.kind = "file"; this.name = name; this.bytes = new Uint8Array(); }
  async createWritable({ keepExistingData = false } = {}) {
    let staged = keepExistingData ? this.bytes.slice() : new Uint8Array();
    return {
      write: async (value) => {
        if (value?.type === "write") {
          const data = new Uint8Array(value.data);
          const next = new Uint8Array(Math.max(staged.length, value.position + data.length));
          next.set(staged); next.set(data, value.position); staged = next;
        } else staged = typeof value === "string" ? new TextEncoder().encode(value) : value?.arrayBuffer ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value);
      },
      close: async () => { this.bytes = staged; }, abort: async () => {},
    };
  }
  async getFile() { return new Blob([this.bytes.slice()]); }
}
export class MemoryDirectoryHandle {
  constructor(name) { this.kind = "directory"; this.name = name; this.files = new Map(); this.directories = new Map(); }
  async getDirectoryHandle(name, { create } = {}) {
    if (!this.directories.has(name) && !create) throw new DOMException(`Missing directory: ${name}`, "NotFoundError");
    if (!this.directories.has(name)) this.directories.set(name, new MemoryDirectoryHandle(name));
    return this.directories.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.files.has(name) && !create) throw new DOMException(`Missing file: ${name}`, "NotFoundError");
    if (!this.files.has(name)) this.files.set(name, new MemoryFileHandle(name));
    return this.files.get(name);
  }
  async *values() { yield* this.directories.values(); yield* this.files.values(); }
  async removeEntry(name) { this.files.delete(name); this.directories.delete(name); }
}
