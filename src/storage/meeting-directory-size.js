export async function directorySize(directory) {
  let bytes = 0;
  for await (const entry of directory.values()) {
    bytes += entry.kind === "directory" ? await directorySize(entry) : (await entry.getFile()).size;
  }
  return bytes;
}
