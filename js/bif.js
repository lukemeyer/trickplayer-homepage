/**
 * Pure client-side BIF (Bifrost / Trickplay) parser and frame extractor.
 * Ported from trickplayer-g2 and trickplayer-knowledge specifications.
 */

const MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_BYTES = 64;
const ENTRY_BYTES = 8;

export function parseTimelineHeader(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < HEADER_BYTES) {
    throw new Error(`BIF header truncated: got ${view.byteLength} bytes, need ${HEADER_BYTES}`);
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (view.getUint8(i) !== MAGIC[i]) {
      throw new Error("Not a valid BIF file: magic bytes mismatch");
    }
  }

  const version = view.getUint32(8, true);
  const frameCount = view.getUint32(12, true);
  const rawMultiplier = view.getUint32(16, true);
  // Per BIF spec & finding F-004: 0 means default 1000ms, not 0ms.
  const multiplierMs = rawMultiplier === 0 ? 1000 : rawMultiplier;
  const indexByteLength = HEADER_BYTES + ENTRY_BYTES * (frameCount + 1);

  return {
    version,
    frameCount,
    rawMultiplier,
    multiplierMs,
    indexByteLength,
  };
}

export function parseTimelineIndex(buffer) {
  const header = parseTimelineHeader(buffer);
  const view = new DataView(buffer);
  if (view.byteLength < header.indexByteLength) {
    throw new Error(`BIF index truncated: got ${view.byteLength} bytes, need ${header.indexByteLength}`);
  }

  const frames = [];
  for (let i = 0; i < header.frameCount; i++) {
    const at = HEADER_BYTES + ENTRY_BYTES * i;
    const tsMs = view.getUint32(at, true) * header.multiplierMs;
    const offset = view.getUint32(at + 4, true);
    const end = view.getUint32(at + ENTRY_BYTES + 4, true);
    frames.push({
      index: i,
      tsMs,
      offset,
      length: end - offset,
    });
  }

  return {
    frameCount: header.frameCount,
    multiplierMs: header.multiplierMs,
    durationMs: frames.length ? frames[frames.length - 1].tsMs + header.multiplierMs * 2 : 0,
    frames,
  };
}

export function extractFrameBlob(buffer, frame) {
  const slice = new Uint8Array(buffer, frame.offset, frame.length);
  return new Blob([slice], { type: "image/jpeg" });
}

export function extractFrameUrl(buffer, frame) {
  const blob = extractFrameBlob(buffer, frame);
  return URL.createObjectURL(blob);
}
