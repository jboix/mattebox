/**
 * Segmented HLS subtitles: the X-TIMESTAMP-MAP header maps each segment's
 * local cue times into MPEG-TS presentation time. This stage is a byte
 * transform, ordered ahead of parsing: it shifts every cue timing by the
 * segment's offset and strips the header, so the plain-VTT parser in
 * text-webvtt never learns HLS exists. The offset is per segment, not per
 * playlist; that is the bug this design makes unrepresentable.
 */
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

const MPEGTS_TIMESCALE = 90_000;

function timestampToSeconds(text: string): number {
  const [rest, millis] = text.split('.');
  const parts = (rest ?? '').split(':').map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0) + Number(millis ?? 0) / 1000;
}

function secondsToTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** Applies the segment's X-TIMESTAMP-MAP to every cue timing, in text. */
export function shiftTimestampMap(text: string): string {
  const header = /X-TIMESTAMP-MAP=([^\r\n]+)/.exec(text);
  if (header === null) return text;
  let local = 0;
  let mpegts = 0;
  for (const part of (header[1] as string).split(',')) {
    const [key, value] = splitOnce(part.trim());
    if (key === 'LOCAL') local = timestampToSeconds(value);
    if (key === 'MPEGTS') mpegts = Number(value);
  }
  const offset = mpegts / MPEGTS_TIMESCALE - local;
  const stripped = text.replace(/X-TIMESTAMP-MAP=[^\r\n]*\r?\n?/, '');
  return stripped.replace(
    /((?:\d+:)?[0-5]\d:[0-5]\d\.\d{3})(\s+-->\s+)((?:\d+:)?[0-5]\d:[0-5]\d\.\d{3})/g,
    (_, start: string, arrow: string, end: string) =>
      `${secondsToTimestamp(timestampToSeconds(start) + offset)}${arrow}${secondsToTimestamp(
        timestampToSeconds(end) + offset,
      )}`,
  );
}

function splitOnce(part: string): [string, string] {
  const index = part.indexOf(':');
  if (index === -1) return [part, ''];
  return [part.slice(0, index), part.slice(index + 1)];
}

export default function textWebvttSegmented(): Stage {
  return {
    name: 'text-webvtt-segmented',
    provides: ['text-webvtt-segmented'],
    requires: ['text-webvtt'],
    install(ctx) {
      ctx.registerTransform({
        name: 'vtt-timestamp-map',
        // Early: decrypt-class steps use lower orders, parsing happens last.
        order: 50,
        transform(data: Uint8Array, meta: SegmentMeta): Uint8Array {
          if (meta.contentType !== 'text') return data;
          const text = new TextDecoder().decode(data);
          if (!text.includes('X-TIMESTAMP-MAP')) return data;
          return new TextEncoder().encode(shiftTimestampMap(text));
        },
      });
    },
  };
}
