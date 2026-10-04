import { fields, nested, string } from "../lib/proto-wire.js";

export function decodeCaption(bytes, label) {
  const root = fields(bytes);
  if (label === "captions") {
    const caption = nested(root, 1), speakerId = string(caption, 1), text = string(caption, 6);
    const id = caption.get(2)?.[0], revision = caption.get(3)?.[0];
    if (!speakerId || !text || id == null || !Number.isSafeInteger(revision)) return null;
    return { utteranceId: JSON.stringify([speakerId, String(id)]), revision, text, speakerId,
      ...(caption.has(8) ? { language: String(caption.get(8)[0]) } : {}) };
  }
  if (label !== "captions_v2") return null;
  const envelope = nested(root, 1), caption = nested(envelope, 1), body = nested(caption, 3);
  const speakerId = string(body, 6), text = string(body, 3), id = caption.get(1)?.[0], revision = caption.get(2)?.[0];
  if (!speakerId || !text || id == null || !Number.isSafeInteger(revision)) return null;
  const timestamp = nested(envelope, 6).get(1)?.[0];
  return { utteranceId: JSON.stringify([speakerId, String(id)]), revision, speakerId, text,
    ...(body.has(2) ? { isFinal: body.get(2)[0] === 1 } : {}),
    ...(body.has(4) ? { language: string(body, 4) } : {}),
    ...(body.has(5) ? { translationLanguage: string(body, 5) } : {}),
    ...(timestamp != null ? { protocolTimestamp: timestamp } : {}) };
}
export function decodeCaptionRoster(bytes) {
  const wrapper = nested(nested(fields(bytes), 1), 2);
  const users = nested(nested(wrapper, 13), 1).get(2) ?? [];
  return users.map((encoded) => {
    const user = fields(encoded);
    return { speakerId: string(user, 1), speaker: string(user, 2) || string(user, 29) || null };
  }).filter((user) => user.speakerId);
}
