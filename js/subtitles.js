/**
 * Subtitle parser and cleaner for SRT sidecars.
 * Ported from trickplayer-g2/src/subtitles.ts.
 */

/**
 * Strips HTML tags and ASS/SSA styling blocks like {\an8} from subtitle text.
 */
export function cleanSubText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, "")             // Strip HTML tags
    .replace(/\{[^\}]+\}/g, "")           // Strip ASS/SSA override tags
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/**
 * Parses timestamp string "00:01:23,456" or "00:01:23.456" into milliseconds.
 */
export function parseTimestampMs(str) {
  if (!str) return 0;
  const parts = str.trim().split(/[:,.]/);
  if (parts.length < 3) return 0;
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const s = parseInt(parts[2], 10) || 0;
  const ms = parts[3] ? parseInt(parts[3].padEnd(3, "0").slice(0, 3), 10) : 0;
  return (h * 3600 + m * 60 + s) * 1000 + ms;
}

/**
 * Parses an SRT subtitle file into an array of cues.
 */
export function parseSrt(srtText) {
  if (!srtText) return [];
  const normalized = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    // Line 0 is often sequence number, but sometimes files omit it
    let timeLineIdx = 0;
    if (!lines[0].includes("-->") && lines[1] && lines[1].includes("-->")) {
      timeLineIdx = 1;
    } else if (!lines[0].includes("-->")) {
      continue;
    }

    const timeMatch = lines[timeLineIdx].match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!timeMatch) continue;

    const startMs = parseTimestampMs(timeMatch[1]);
    const endMs = parseTimestampMs(timeMatch[2]);
    const rawText = lines.slice(timeLineIdx + 1).join("\n");
    const text = cleanSubText(rawText);

    if (text.length > 0) {
      cues.push({
        startMs,
        endMs,
        text,
      });
    }
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Finds the subtitle cue that is active at currentTimeMs.
 */
export function findActiveCue(cues, currentTimeMs) {
  return cues.find((c) => currentTimeMs >= c.startMs && currentTimeMs <= c.endMs) || null;
}
