/**
 * Several DASH Periods as one continuous presentation, the way Shaka
 * Player combines periods. Each logical track keeps one id for the whole
 * presentation, and its renditions list every period's segments in order.
 * A period boundary is a discontinuity, so the kernel's epoch model, the
 * same one HLS discontinuities use, settles each period's timestamp offset
 * from the media's own decode times. Nothing about periods reaches the
 * kernel.
 *
 * Tracks match across periods by, in order: the period continuity or
 * connectivity descriptor (ISO/IEC 23009-1 §5.3.2.4), the AdaptationSet id,
 * then content type, language, role, and codec family. A period without a
 * match fills an audio or video track with its closest track (same
 * language, then same codec family, then the first), so playback never
 * meets a hole; a text track simply has nothing there. Renditions pair by
 * the nearest bitrate.
 *
 * A segment whose period has another init than its rendition's carries it
 * (`Segment.init`): the dash-cmaf stage puts it in front of the segment
 * before the append. A period whose codec family differs from the first
 * period's is left out, with a warning: switching families needs a
 * `changeType()`, which only the kernel can call. Text whose times count
 * from its period's start carries that start (`Segment.timeOffset`).
 */
import { isIndexed, isUnresolved, segmentAt } from '../../kernel/timeline.js';
import type { MatteboxError } from '../../types/error.js';
import type { PresentationEvent, Rendition, Segment, SegmentRef, Track } from '../../types/ir.js';

/** One Period parsed on its own: its tracks, events, and what matches them across periods. */
export interface ParsedPeriod {
  readonly id: string;
  readonly start: number;
  readonly duration: number | null;
  readonly tracks: readonly Track[];
  readonly events: readonly PresentationEvent[];
  /** By track id: the AdaptationSet id and the periods it continues. */
  readonly matching: ReadonlyMap<
    string,
    { readonly asId: string | null; readonly follows: readonly string[] }
  >;
}

export interface FlatPresentation {
  readonly tracks: Track[];
  readonly events: PresentationEvent[];
  /** A non-fatal MEDIA_CODEC_MISMATCH per period left out; context holds its span. */
  readonly warnings: MatteboxError[];
}

/** The codec family, as `changeType()` cares: avc1 and avc3 are one, hvc1 and hev1 are one. */
function family(codecs: string | null): string {
  const first = (codecs ?? '').split(',')[0]?.trim().split('.')[0]?.toLowerCase() ?? '';
  if (first === 'avc3') return 'avc1';
  if (first === 'hev1') return 'hvc1';
  if (first === 'dvhe') return 'dvh1';
  return first;
}

/** Text whose cue times count from its period's start: whole documents, not fMP4 samples. */
function periodRelative(track: Track): boolean {
  return track.mimeType === 'text/vtt' || track.mimeType === 'application/ttml+xml';
}

/** A rendition's segments as a list, or null when only an index would tell (SegmentBase). */
function listed(rendition: Rendition, periodStart: number): Segment[] | null {
  const addressing = rendition.segments;
  if (isUnresolved(addressing)) return null;
  if (!isIndexed(addressing)) return [...(addressing as readonly Segment[])];
  if (addressing.endSeq === null) return null;
  const out: Segment[] = [];
  for (let seq = addressing.startSeq; seq <= addressing.endSeq; seq += 1) {
    const segment = segmentAt(addressing, seq, periodStart);
    if (segment !== null) out.push(segment);
  }
  return out;
}

function sameRef(a: SegmentRef | undefined, b: SegmentRef | undefined): boolean {
  return (
    a?.url === b?.url &&
    a?.byteRange?.start === b?.byteRange?.start &&
    a?.byteRange?.end === b?.byteRange?.end
  );
}

function nearest(renditions: readonly Rendition[], bitrate: number): Rendition | undefined {
  let best: Rendition | undefined;
  for (const rendition of renditions) {
    if (
      best === undefined ||
      Math.abs(rendition.bitrate - bitrate) < Math.abs(best.bitrate - bitrate)
    ) {
      best = rendition;
    }
  }
  return best;
}

interface Logical {
  readonly id: string;
  /** The track it was first seen as, which names it and gives its renditions. */
  readonly base: Track;
  readonly baseIndex: number;
  readonly asId: string | null;
  /** By period index, the track that plays in it. */
  readonly byPeriod: Map<number, Track>;
}

/** Combines the periods, or null when one of them lists no segments (SegmentBase). */
export function flattenPeriods(periods: readonly ParsedPeriod[]): FlatPresentation | null {
  const logical: Logical[] = [];
  const captions = new Map<string, Track>();

  periods.forEach((period, index) => {
    for (const track of period.tracks) {
      // In-band caption tracks carry no segments; one per channel overall.
      if (track.renditions.length === 0) {
        if (!captions.has(track.id)) captions.set(track.id, track);
        continue;
      }
      const meta = period.matching.get(track.id);
      const open = logical.filter(
        (l) => !l.byPeriod.has(index) && l.base.contentType === track.contentType,
      );
      const earlier = new Set(periods.slice(0, index).map((p) => p.id));
      const match =
        open.find(
          (l) =>
            meta !== undefined &&
            l.asId === meta.asId &&
            meta.follows.some((id) => earlier.has(id)),
        ) ??
        open.find((l) => meta?.asId != null && l.asId === meta.asId) ??
        open.find(
          (l) =>
            l.base.lang === track.lang &&
            l.base.role === track.role &&
            family(l.base.renditions[0]?.codecs ?? null) ===
              family(track.renditions[0]?.codecs ?? null),
        );
      if (match !== undefined) {
        match.byPeriod.set(index, track);
        continue;
      }
      // A later period's other video (an ad's) fills the first period's
      // video track below; it does not start a track of its own.
      if (track.contentType === 'video' && logical.some((l) => l.base.contentType === 'video')) {
        continue;
      }
      const taken = logical.some((l) => l.id === track.id);
      logical.push({
        id: taken ? `${period.id}/${track.id}` : track.id,
        base: track,
        baseIndex: index,
        asId: meta?.asId ?? null,
        byPeriod: new Map([[index, track]]),
      });
    }
  });

  // Audio and video never meet a hole: a period without a match plays its closest track.
  for (const l of logical) {
    if (l.base.contentType !== 'audio' && l.base.contentType !== 'video') continue;
    periods.forEach((period, index) => {
      if (l.byPeriod.has(index)) return;
      const candidates = period.tracks.filter(
        (t) =>
          t.contentType === l.base.contentType && t.renditions.length > 0 && t.role !== 'trick',
      );
      const sameFamily = (t: Track) =>
        family(t.renditions[0]?.codecs ?? null) === family(l.base.renditions[0]?.codecs ?? null);
      const sameLanguage = (t: Track) => t.lang !== undefined && t.lang === l.base.lang;
      const closest =
        candidates.find((t) => sameLanguage(t) && sameFamily(t)) ??
        candidates.find(sameFamily) ??
        candidates.find(sameLanguage) ??
        candidates[0];
      if (closest !== undefined) l.byPeriod.set(index, closest);
    });
  }

  // A period whose audio or video changes codec family is left out whole.
  // Only the first period's tracks decide: a track that appears later gets
  // a gap where it cannot play, below.
  const warnings: MatteboxError[] = [];
  const skipped = new Set<number>();
  periods.forEach((period, index) => {
    for (const l of logical) {
      if (l.baseIndex !== 0) continue;
      if (l.base.contentType !== 'audio' && l.base.contentType !== 'video') continue;
      const track = l.byPeriod.get(index);
      const declared = l.base.renditions[0]?.codecs ?? null;
      const actual = track?.renditions[0]?.codecs ?? null;
      if (track === undefined || family(declared) === family(actual) || skipped.has(index))
        continue;
      skipped.add(index);
      warnings.push({
        category: 'media',
        code: 'MEDIA_CODEC_MISMATCH',
        fatal: false,
        recoverable: true,
        context: {
          kind: 'family',
          declared: declared ?? '',
          probed: actual ?? '',
          period: period.id,
          start: period.start,
          end: period.duration === null ? period.start : period.start + period.duration,
        },
      });
    }
  });

  const tracks: Track[] = [];
  for (const l of logical) {
    const renditions: Rendition[] = [];
    for (const base of l.base.renditions) {
      const segments: Segment[] = [];
      for (let index = 0; index < periods.length; index += 1) {
        const period = periods[index] as ParsedPeriod;
        const track = l.byPeriod.get(index);
        if (track === undefined || skipped.has(index)) continue;
        const media = track.contentType === 'audio' || track.contentType === 'video';
        if (media && family(track.renditions[0]?.codecs ?? null) !== family(base.codecs)) continue;
        const rendition = track === l.base ? base : nearest(track.renditions, base.bitrate);
        if (rendition === undefined) continue;
        const list = listed(rendition, period.start);
        if (list === null) return null;
        const init = sameRef(rendition.init, base.init) ? undefined : rendition.init;
        const offset = periodRelative(track) && period.start !== 0 ? period.start : 0;
        list.forEach((segment, i) => {
          segments.push({
            ...segment,
            seq: segments.length,
            // Each period opens an epoch, numbered by its period.
            ...(i === 0 ? { discontinuity: index > 0, discontinuitySequence: index } : {}),
            ...(init !== undefined ? { init } : {}),
            ...(offset !== 0 ? { timeOffset: offset } : {}),
          });
        });
      }
      renditions.push({ ...base, segments });
    }
    tracks.push({ ...l.base, id: l.id, renditions });
  }
  for (const caption of captions.values()) tracks.push(caption);

  return {
    tracks,
    events: periods.flatMap((period) => period.events),
    warnings,
  };
}
