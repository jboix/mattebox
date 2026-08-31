/**
 * WebVTT into cue descriptors. Pure, plain-VTT only: the HLS X-TIMESTAMP-MAP
 * header is a segmented-delivery concern that text-webvtt-segmented rewrites
 * away as a byte transform before this parser ever sees the text.
 *
 * Malformed cues are skipped, never thrown: one bad cue must not cost the
 * segment. Every cue carries a deterministic id so re-delivered segments
 * dedup at the sink.
 */
import type { CueDescriptor } from '../../types/messages.js';

/** `HH:MM:SS.mmm` or `MM:SS.mmm` to seconds, or null. */
export function parseTimestamp(text: string): number | null {
  const match = /^(?:(\d+):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(text.trim());
  if (match === null) return null;
  const [, hours, minutes, seconds, millis] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
}

/** djb2 over the cue text; enough identity for dedup, not cryptography. */
function hash(text: string): string {
  let value = 5381;
  for (let i = 0; i < text.length; i += 1) {
    value = ((value << 5) + value + text.charCodeAt(i)) >>> 0;
  }
  return value.toString(36);
}

export interface VttParseResult {
  readonly cues: readonly CueDescriptor[];
  /** Cue blocks skipped as malformed; surfaced as a warning, never an error. */
  readonly skipped: number;
}

export function parseVtt(text: string): VttParseResult {
  // Strip a BOM; the signature check is on the first line proper.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.startsWith('WEBVTT')) return { cues: [], skipped: 0 };

  const cues: CueDescriptor[] = [];
  let skipped = 0;
  // Blocks separated by blank lines; the first block is the header.
  const blocks = body.split(/\r?\n\r?\n/).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((line) => line !== '');
    if (lines.length === 0) continue;
    const first = lines[0] as string;
    if (first.startsWith('NOTE') || first.startsWith('STYLE') || first.startsWith('REGION')) {
      continue;
    }
    // An optional id line precedes the timing line.
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1 || timingIndex > 1) {
      skipped += 1;
      continue;
    }
    const id = timingIndex === 1 ? first : undefined;
    const timing = lines[timingIndex] as string;
    const [startText, rest] = timing.split('-->');
    const settingsMatch = (rest ?? '').trim().split(/\s+/);
    const start = parseTimestamp(startText ?? '');
    const end = parseTimestamp(settingsMatch[0] ?? '');
    if (start === null || end === null || end <= start) {
      skipped += 1;
      continue;
    }
    const settings = settingsMatch.slice(1).join(' ');
    const cueText = lines.slice(timingIndex + 1).join('\n');
    cues.push({
      id: id ?? `${Math.round(start * 1000)}-${Math.round(end * 1000)}-${hash(cueText)}`,
      start,
      end,
      text: cueText,
      ...(settings !== '' ? { settings } : {}),
    });
  }
  return { cues, skipped };
}
