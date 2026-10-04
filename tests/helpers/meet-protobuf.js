export const text = (value) => new TextEncoder().encode(value);
export function varint(value) {
  let current = BigInt(value); const result = [];
  do { let byte = Number(current & 127n); current >>= 7n; if (current) byte |= 128; result.push(byte); } while (current);
  return result;
}
export function field(id, value) {
  return typeof value === "number" || typeof value === "bigint" ? [...varint(id * 8), ...varint(value)] :
    [...varint(id * 8 + 2), ...varint(value.length), ...value];
}
export const oldCaption = (id = 1, revision = 1, value = "Hola", device = "ana") => new Uint8Array(field(1, [
  ...field(1, text(device)), ...field(2, id), ...field(3, revision), ...field(6, text(value)), ...field(8, 1),
]));
export const v2Caption = (id = 1, revision = 1, value = "Hola", device = "ana") => new Uint8Array(field(1, [
  ...field(1, [...field(1, id), ...field(2, revision), ...field(3, [
    ...field(2, 1), ...field(3, text(value)), ...field(4, text("es")), ...field(6, text(device)),
  ])]), ...field(6, field(1, 123)),
]));
export const roster = (device = "ana", name = "Ana") => new Uint8Array(field(1, field(2, field(13, field(1, field(2, [
  ...field(1, text(device)), ...field(2, text(name)),
]))))));
