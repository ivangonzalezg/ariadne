import { forEachField } from "./protobuf-lite.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function readString(bytes) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

function decodeFields(bytes, onField) {
  let valid = true;
  const complete = forEachField(bytes, (entry) => {
    if (!onField(entry)) valid = false;
  });
  return complete && valid;
}

function decodeV1Caption(bytes) {
  const caption = {
    captionId: 0,
    version: 0,
    text: null,
    deviceSpace: "",
    languageId: 0,
  };
  const seen = new Set();

  const valid = decodeFields(bytes, ({ field, wire, value, bytes: fieldBytes }) => {
    if (field === 1 || field === 6) {
      if (wire !== 2) return false;
      const string = readString(fieldBytes);
      if (string === null) return false;
      if (field === 1) caption.deviceSpace = string;
      else caption.text = string;
      seen.add(field);
    } else if (field === 2 || field === 3 || field === 8) {
      if (wire !== 0) return false;
      if (field === 2) caption.captionId = value;
      else if (field === 3) caption.version = value;
      else caption.languageId = value;
      seen.add(field);
    }
    return true;
  });

  return valid && seen.has(6) ? caption : null;
}

function decodeV2Body(bytes) {
  const body = {
    isFinal: false,
    text: null,
    language: "",
    translationLanguage: "",
    deviceSpace: "",
  };
  const seen = new Set();

  const valid = decodeFields(bytes, ({ field, wire, value, bytes: fieldBytes }) => {
    if (field === 2) {
      if (wire !== 0) return false;
      body.isFinal = value !== 0 && value !== 0n;
      seen.add(field);
    } else if (field === 3 || field === 4 || field === 5 || field === 6) {
      if (wire !== 2) return false;
      const string = readString(fieldBytes);
      if (string === null) return false;
      if (field === 3) body.text = string;
      else if (field === 4) body.language = string;
      else if (field === 5) body.translationLanguage = string;
      else body.deviceSpace = string;
      seen.add(field);
    }
    return true;
  });

  return valid && seen.has(3) ? body : null;
}

function decodeV2Header(bytes) {
  const header = { captionId: 0, version: 0, body: null };
  const seen = new Set();

  const valid = decodeFields(bytes, ({ field, wire, value, bytes: fieldBytes }) => {
    if (field === 1 || field === 2) {
      if (wire !== 0) return false;
      if (field === 1) header.captionId = value;
      else header.version = value;
      seen.add(field);
    } else if (field === 3) {
      if (wire !== 2) return false;
      const body = decodeV2Body(fieldBytes);
      if (!body) return false;
      header.body = body;
      seen.add(field);
    }
    return true;
  });

  return valid && seen.has(3) ? header : null;
}

function decodeV2Timestamp(bytes) {
  let timestampSeconds = null;
  let seen = false;
  const valid = decodeFields(bytes, ({ field, wire, value }) => {
    if (field !== 1) return true;
    if (wire !== 0) return false;
    timestampSeconds = value;
    seen = true;
    return true;
  });
  return valid && seen ? timestampSeconds : null;
}

/** Decodes a `captions` (v1) data-channel message into the shared caption shape. */
export function decodeCaptionV1(bytes) {
  try {
    let caption = null;
    let hasCaption = false;
    let invalidUnknown = false;

    const valid = decodeFields(bytes, ({ field, wire, bytes: fieldBytes }) => {
      if (field === 1) {
        if (wire !== 2) return false;
        const decoded = decodeV1Caption(fieldBytes);
        if (!decoded) return false;
        caption = decoded;
        hasCaption = true;
      } else if (field === 2) {
        if (wire !== 2) return false;
        const unknown = readString(fieldBytes);
        if (unknown === null) return false;
        if (unknown.length > 0) invalidUnknown = true;
      }
      return true;
    });

    if (!valid || !hasCaption || invalidUnknown || !caption) return null;
    return {
      schema: "v1",
      captionId: caption.captionId,
      version: caption.version,
      text: caption.text,
      isFinal: null,
      deviceSpace: caption.deviceSpace,
      languageId: caption.languageId,
      timestampSeconds: null,
    };
  } catch {
    return null;
  }
}

/** Decodes a `captions_v2` data-channel message into the shared caption shape. */
export function decodeCaptionV2(bytes) {
  try {
    let header = null;
    let timestampSeconds = null;
    let hasHeader = false;
    let hasTimestamp = false;

    const valid = decodeFields(bytes, ({ field, wire, bytes: fieldBytes }) => {
      if (field === 1) {
        if (wire !== 2) return false;
        const decoded = decodeV2Header(fieldBytes);
        if (!decoded) return false;
        header = decoded;
        hasHeader = true;
      } else if (field === 6) {
        if (wire !== 2) return false;
        const decoded = decodeV2Timestamp(fieldBytes);
        if (decoded === null) return false;
        timestampSeconds = decoded;
        hasTimestamp = true;
      }
      return true;
    });

    if (!valid || !hasHeader || !hasTimestamp || !header) return null;
    return {
      schema: "v2",
      captionId: header.captionId,
      version: header.version,
      text: header.body.text,
      isFinal: header.body.isFinal,
      deviceSpace: header.body.deviceSpace,
      languageId: null,
      timestampSeconds,
    };
  } catch {
    return null;
  }
}
