/**
 * Low-latency HLS media playlists (RFC 8216bis §4.4.3.7, §4.4.3.8,
 * §4.4.4.9, §4.4.5.2 to §4.4.5.4). The base parser reads the segments; this
 * pass reads the parts, the preload hint, the rendition reports, and the
 * delivery directives for the next reload. Pure.
 *
 * Near the edge each segment that lists its parts is replaced by them in
 * the IR, one entry per part, so the kernel fetches and appends a part as
 * soon as it exists. Servers drop a segment's parts once it is three target
 * durations old (§6.2.2), by then far behind the playhead, and the full
 * segment takes their place. A part's sequence number is its segment's plus
 * the part index over PART_SCALE, so parts sort between segments and keep
 * the same number across reloads.
 */
import { resolveUrl as resolve } from '../../kernel/url.js';
import type { ByteRange, DateRange, Segment, SegmentAddressing } from '../../types/ir.js';
import { manifestError } from '../adapter-shared.js';
import type { Line, TagLine } from '../hls-cmaf/lexer.js';
import { lex } from '../hls-cmaf/lexer.js';
import type { MediaPlaylist, MediaPlaylistResult } from '../hls-cmaf/parse.js';
import { parseByteRange, parseMediaLines } from '../hls-cmaf/parse.js';

/** Parts per segment the numbering leaves room for. */
const PART_SCALE = 1000;

/** The position the next blocking reload asks for (RFC 8216bis §6.2.5.2). */
export interface NextPosition {
  readonly msn: number;
  /** Absent when the playlist has no parts: the reload waits for a whole segment. */
  readonly part?: number;
}

/** A media playlist with what low latency adds. */
export interface LowLatencyPlaylist extends MediaPlaylist {
  /** EXT-X-PART-INF PART-TARGET, in seconds; 0 without parts. */
  readonly partTarget: number;
  /** The segment and part a blocking reload waits for. */
  readonly next: NextPosition;
  /**
   * Per other rendition's playlist URL, the URL that loads it at its last
   * part at once (EXT-X-RENDITION-REPORT), for a switch at the edge.
   */
  readonly reports: Readonly<Record<string, string>>;
}

interface Part {
  readonly duration: number;
  readonly url: string;
  readonly byteRange?: ByteRange;
  readonly independent: boolean;
  readonly gap: boolean;
}

function partFrom(
  line: TagLine,
  baseUrl: string,
  previous: { url: string; end: number } | null,
): Part | null {
  const uri = line.attributes.URI;
  const duration = Number(line.attributes.DURATION);
  if (uri === undefined || !(duration > 0)) return null;
  const url = resolve(uri, baseUrl);
  const rangeText = line.attributes.BYTERANGE;
  // A BYTERANGE without an offset continues the previous part of the same
  // resource (RFC 8216bis §4.4.4.9).
  const byteRange =
    rangeText === undefined
      ? null
      : parseByteRange(rangeText, previous?.url === url ? previous.end : null);
  return {
    duration,
    url,
    ...(byteRange !== null ? { byteRange } : {}),
    independent: line.attributes.INDEPENDENT === 'YES',
    gap: line.attributes.GAP === 'YES',
  };
}

/** EXT-X-DISCONTINUITY-SEQUENCE, 0 without the tag (RFC 8216 §4.3.3.3). */
function discontinuitySequenceOf(lines: readonly Line[]): number {
  for (const line of lines) {
    if (line.kind === 'tag' && line.name === 'EXT-X-DISCONTINUITY-SEQUENCE') {
      return Number(line.value) || 0;
    }
  }
  return 0;
}

/**
 * A delta update request (RFC 8216bis §6.2.5.1): `v2` also skips the date
 * ranges the client has, `YES` the segments only.
 */
export type SkipRequest = 'YES' | 'v2' | null;

/** The URL with the delivery directives (RFC 8216bis §6.2.5) in their defined order. */
export function withDirectives(url: string, position: NextPosition, skip: SkipRequest): string {
  const params = [`_HLS_msn=${position.msn}`];
  if (position.part !== undefined) params.push(`_HLS_part=${position.part}`);
  if (skip !== null) params.push(`_HLS_skip=${skip}`);
  return `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}`;
}

/**
 * A delta update's skipped segments, taken from the rendition's previous
 * segments, with the listed ones moved onto the same timeline. Null when
 * the previous segments do not hold every skipped one: the caller then
 * reloads the whole playlist.
 *
 * The date ranges are the previous ones without those the server removed,
 * merged by ID with the listed ones, as hls.js merges them: a `v2` delta
 * leaves out the date ranges the client has.
 */
function fillSkipped(
  playlist: MediaPlaylist,
  skipped: number,
  previous: SegmentAddressing,
  previousRanges: readonly DateRange[],
): MediaPlaylist | null {
  if (!Array.isArray(previous)) return null;
  const first = playlist.mediaSequence;
  const listedFrom = first + skipped;
  const kept = (previous as readonly Segment[]).filter(
    (s) => s.preload !== true && s.seq >= first && s.seq < listedFrom,
  );
  const have = new Set(kept.map((s) => Math.floor(s.seq)));
  for (let seq = first; seq < listedFrom; seq += 1) if (!have.has(seq)) return null;
  const last = kept[kept.length - 1] as Segment;
  const listedStart = playlist.segments[0]?.start ?? 0;
  const shift = last.start + last.duration - listedStart;
  const anchor = playlist.dateAnchor;
  return {
    ...playlist,
    segments: [...kept, ...playlist.segments.map((s) => ({ ...s, start: s.start + shift }))],
    ...(anchor !== undefined
      ? {
          dateAnchor: {
            wallClock: anchor.wallClock,
            presentationTime: anchor.presentationTime + shift,
          },
        }
      : {}),
    ...mergedRanges(playlist, previousRanges, shift),
    skipped: 0,
  };
}

/** The delta's date ranges moved by `shift`, over the previous ones it keeps. */
function mergedRanges(
  playlist: MediaPlaylist,
  previousRanges: readonly DateRange[],
  shift: number,
): { dateRanges?: readonly DateRange[] } {
  const removed = new Set(playlist.removedDateRanges ?? []);
  const byId = new Map<string, DateRange>();
  for (const range of previousRanges) if (!removed.has(range.id)) byId.set(range.id, range);
  for (const r of playlist.dateRanges ?? []) {
    byId.set(r.id, {
      ...r,
      start: r.start + shift,
      ...(r.end !== undefined ? { end: r.end + shift } : {}),
      ...(r.plannedEnd !== undefined ? { plannedEnd: r.plannedEnd + shift } : {}),
    });
  }
  return byId.size > 0 ? { dateRanges: [...byId.values()] } : {};
}

/** The IR entries of one segment's parts, from `start` on. */
function partEntries(
  parts: readonly Part[],
  seq: number,
  start: number,
  first: Partial<Segment>,
  marksIndependent: boolean,
): Segment[] {
  const out: Segment[] = [];
  let at = start;
  parts.forEach((part, index) => {
    out.push({
      ...(index === 0 ? first : {}),
      seq: seq + index / PART_SCALE,
      start: at,
      duration: part.duration,
      url: part.url,
      ...(part.byteRange !== undefined ? { byteRange: part.byteRange } : {}),
      ...(marksIndependent ? { independent: part.independent } : {}),
    });
    at += part.duration;
  });
  return out;
}

/**
 * Parses a low-latency media playlist. `previous` is the rendition's
 * segments now, for a delta update. When a delta update cannot be filled,
 * the result keeps `skipped` above 0.
 */
export function parseLowLatency(
  text: string,
  baseUrl: string,
  previous: SegmentAddressing = [],
  previousRanges: readonly DateRange[] = [],
): MediaPlaylistResult {
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { playlist: null, error: manifestError('missing #EXTM3U') };
  }
  const lines: readonly Line[] = lex(text);
  const base = parseMediaLines(lines, baseUrl);
  if (base.playlist === null) return base;
  let playlist: MediaPlaylist = base.playlist;
  const skipped = playlist.skipped ?? 0;
  if (skipped > 0) {
    const filled = fillSkipped(playlist, skipped, previous, previousRanges);
    if (filled === null) return base;
    playlist = filled;
  }

  let partTarget = 0;
  let msn = base.playlist.mediaSequence + skipped;
  let pending: Part[] = [];
  let lastPart: { url: string; end: number } | null = null;
  let hint: { url: string; byteRange?: ByteRange } | null = null;
  const partsBySeq = new Map<number, readonly Part[]>();
  const reports: Record<string, string> = {};
  for (const line of lines) {
    if (line.kind === 'uri') {
      if (pending.length > 0) partsBySeq.set(msn, pending);
      pending = [];
      msn += 1;
      continue;
    }
    const attributes = line.attributes;
    switch (line.name) {
      case 'EXT-X-PART-INF':
        partTarget = Number(attributes['PART-TARGET']) || 0;
        break;
      case 'EXT-X-PART': {
        const part = partFrom(line, baseUrl, lastPart);
        if (part === null) break;
        pending.push(part);
        lastPart = part.byteRange !== undefined ? { url: part.url, end: part.byteRange.end } : null;
        break;
      }
      case 'EXT-X-PRELOAD-HINT': {
        const uri = attributes.URI;
        if (attributes.TYPE !== 'PART' || uri === undefined) break;
        const start = Number(attributes['BYTERANGE-START']);
        const length = Number(attributes['BYTERANGE-LENGTH']);
        // A start without a length asks for the rest of the resource as it
        // grows (RFC 8216bis §4.4.5.3).
        hint = {
          url: resolve(uri, baseUrl),
          ...(Number.isFinite(start)
            ? { byteRange: { start, end: length > 0 ? start + length - 1 : Infinity } }
            : {}),
        };
        break;
      }
      case 'EXT-X-RENDITION-REPORT': {
        const uri = attributes.URI;
        const last = Number(attributes['LAST-MSN']);
        if (uri === undefined || !Number.isFinite(last)) break;
        const part = Number(attributes['LAST-PART']);
        reports[resolve(uri, baseUrl)] = withDirectives(
          resolve(uri, baseUrl),
          { msn: last, ...(Number.isFinite(part) ? { part } : {}) },
          null,
        );
        break;
      }
      default:
        break;
    }
  }
  // Parts after the last segment belong to the one being written now.
  const trailing = pending;

  // A playlist that marks no part independent says nothing about where
  // decoding can start; then every part counts as a start, as audio's do.
  const marksIndependent = [...partsBySeq.values(), trailing].some((parts) =>
    parts.some((p) => p.independent),
  );
  const segments: Segment[] = [];
  for (const segment of playlist.segments) {
    const parts = partsBySeq.get(segment.seq);
    const total = parts?.reduce((sum, p) => sum + p.duration, 0) ?? 0;
    // Only a segment whose parts are all listed and present plays from
    // them. AES-128 keys whole segments, so a keyed one stays whole.
    if (
      parts === undefined ||
      parts.some((p) => p.gap) ||
      Math.abs(total - segment.duration) > 0.1 ||
      segment.key !== undefined
    ) {
      segments.push(segment);
      continue;
    }
    const first: Partial<Segment> = {
      ...(segment.discontinuity === true ? { discontinuity: true } : {}),
      ...(segment.discontinuitySequence !== undefined
        ? { discontinuitySequence: segment.discontinuitySequence }
        : {}),
    };
    segments.push(...partEntries(parts, segment.seq, segment.start, first, marksIndependent));
  }
  const lastSegment = playlist.segments[playlist.segments.length - 1];
  const keyed = lastSegment?.key !== undefined;
  const gapAt = trailing.findIndex((p) => p.gap);
  const usable = keyed ? [] : gapAt === -1 ? trailing : trailing.slice(0, gapAt);
  const edge = lastSegment === undefined ? 0 : lastSegment.start + lastSegment.duration;
  segments.push(
    ...partEntries(
      usable,
      msn,
      edge,
      segments.length === 0 ? { discontinuitySequence: discontinuitySequenceOf(lines) } : {},
      marksIndependent,
    ),
  );
  if (hint !== null && !keyed && gapAt === -1 && !playlist.endlist) {
    const last = segments[segments.length - 1];
    segments.push({
      seq: msn + usable.length / PART_SCALE,
      start: last === undefined ? edge : last.start + last.duration,
      duration: partTarget || (last?.duration ?? 1),
      url: hint.url,
      ...(hint.byteRange !== undefined ? { byteRange: hint.byteRange } : {}),
      ...(marksIndependent ? { independent: false } : {}),
      preload: true,
    });
  }

  const hasParts = partTarget > 0 && (partsBySeq.size > 0 || usable.length > 0);
  const partHoldBack = Number(playlist.serverControl?.['PART-HOLD-BACK']);
  // PART-HOLD-BACK applies where the parts play; it is at least two part
  // targets, three recommended (RFC 8216bis §4.4.3.8).
  const holdBack = hasParts
    ? partHoldBack > 0
      ? partHoldBack
      : 3 * partTarget
    : playlist.holdBack;
  const result: LowLatencyPlaylist = {
    ...playlist,
    segments,
    ...(holdBack !== undefined ? { holdBack } : {}),
    ...(hasParts ? { lowLatency: true } : {}),
    partTarget,
    next: partTarget > 0 ? { msn, part: usable.length } : { msn },
    reports,
  };
  return { playlist: result, error: null };
}

/**
 * The URL of the reload after `playlist`: a blocking request for the next
 * part or segment, with a delta update when the server offers one and
 * `skip` allows it. Null when the server does not hold requests
 * (CAN-BLOCK-RELOAD absent): the playlist then reloads on the target
 * duration cadence. Like hls.js, it asks for `v2` when the server can skip
 * date ranges (CAN-SKIP-DATERANGES=YES), else `YES`.
 */
export function nextReload(url: string, playlist: MediaPlaylist, skip: boolean): string | null {
  const control = playlist.serverControl;
  if (control?.['CAN-BLOCK-RELOAD'] !== 'YES' || playlist.endlist) return null;
  const next = (playlist as Partial<LowLatencyPlaylist>).next;
  if (next === undefined) return null;
  let request: SkipRequest = null;
  if (skip && Number(control['CAN-SKIP-UNTIL']) > 0) {
    request = control['CAN-SKIP-DATERANGES'] === 'YES' ? 'v2' : 'YES';
  }
  return withDirectives(url, next, request);
}

/** The rendition reports of a parsed playlist. */
export function reportsOf(playlist: MediaPlaylist): Readonly<Record<string, string>> {
  return (playlist as Partial<LowLatencyPlaylist>).reports ?? {};
}
