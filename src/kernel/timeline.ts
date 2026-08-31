/**
 * Media time to presentation time mapping. A playlist discontinuity and a
 * period boundary are the same concept: a point where the media timeline's
 * mapping to presentation time changes and timestampOffset must be
 * recomputed. Both produce a TimelineEpoch, and everything downstream works
 * on epochs; that shared model is why timeline is kernel and not a stage.
 *
 * Pure functions only. No clocks: the live edge is supplied by the live
 * stages, never computed here.
 */
import type {
  IndexedSegments,
  Period,
  Presentation,
  Rendition,
  Segment,
  SegmentAddressing,
  SidxSegments,
  TimeRange,
} from '../types/ir.js';

/** One continuous stretch of media timeline mapped onto presentation time. */
export interface TimelineEpoch {
  readonly periodId: string;
  /** First segment sequence number belonging to this epoch. */
  readonly firstSeq: number;
  /** Where this epoch starts in presentation time, in seconds. */
  readonly presentationStart: number;
  /**
   * Where the media timestamps start inside the segments, in seconds.
   * Zero until real tfdt values arrive; reconcileTfdt corrects it.
   */
  readonly mediaStart: number;
}

export interface PeriodRendition {
  readonly period: Period;
  readonly rendition: Rendition;
}

function isIndexed(addressing: SegmentAddressing): addressing is IndexedSegments {
  return !Array.isArray(addressing) && (addressing as IndexedSegments).kind === 'indexed';
}

/**
 * An on-demand addressing whose index box has not been fetched yet: it
 * carries no resolvable segments. Once the adapter parses the index it swaps
 * this for an explicit array, so every consumer treats it as empty until then.
 */
function isUnresolved(addressing: SegmentAddressing): boolean {
  return !Array.isArray(addressing) && (addressing as SidxSegments).kind === 'sidx';
}

/**
 * Epochs for one rendition timeline across periods. A period boundary opens
 * an epoch; inside a period, every segment flagged `discontinuity` opens
 * another. One code path for both.
 */
export function buildEpochs(parts: readonly PeriodRendition[]): readonly TimelineEpoch[] {
  const epochs: TimelineEpoch[] = [];
  for (const { period, rendition } of parts) {
    const addressing = rendition.segments;
    if (isIndexed(addressing)) {
      const pto = (addressing.presentationTimeOffset ?? 0) / addressing.timescale;
      epochs.push({
        periodId: period.id,
        firstSeq: addressing.startSeq,
        presentationStart: period.start,
        mediaStart: pto,
      });
      continue;
    }
    if (isUnresolved(addressing)) continue;
    let open = false;
    for (const segment of addressing as readonly Segment[]) {
      if (!open || segment.discontinuity === true) {
        // A period-opening list that begins mid-timeline is a window into
        // a longer stream (a live sliding window): media time is assumed
        // continuous, so the offset is zero. A discontinuity restarts the
        // media clock. tfdt reconciliation corrects both guesses with the
        // bytes' truth once wired.
        const mediaStart = open ? 0 : segment.start - period.start;
        epochs.push({
          periodId: period.id,
          firstSeq: segment.seq,
          presentationStart: segment.start,
          mediaStart,
        });
        open = true;
      }
    }
  }
  return epochs;
}

/** The epoch a sequence number belongs to, or null before the first epoch. */
export function epochForSeq(epochs: readonly TimelineEpoch[], seq: number): TimelineEpoch | null {
  let match: TimelineEpoch | null = null;
  for (const epoch of epochs) {
    if (epoch.firstSeq <= seq) match = epoch;
  }
  return match;
}

/** The timestampOffset an append from this epoch requires. */
export function timestampOffsetFor(epoch: TimelineEpoch): number {
  return epoch.presentationStart - epoch.mediaStart;
}

export function mediaToPresentation(mediaTime: number, epoch: TimelineEpoch): number {
  return mediaTime - epoch.mediaStart + epoch.presentationStart;
}

export function presentationToMedia(presentationTime: number, epoch: TimelineEpoch): number {
  return presentationTime - epoch.presentationStart + epoch.mediaStart;
}

/**
 * Corrects an epoch with a real baseMediaDecodeTime once mp4-box can read
 * tfdt (Stage 07). Interface only for now: manifests promise timing, the
 * bytes tell the truth.
 */
export function reconcileTfdt(
  epoch: TimelineEpoch,
  baseMediaDecodeTime: number,
  timescale: number,
): TimelineEpoch {
  return { ...epoch, mediaStart: baseMediaDecodeTime / timescale };
}

/** Materializes one segment from an indexed form. Null outside the window. */
export function segmentAt(
  addressing: SegmentAddressing,
  seq: number,
  periodStart = 0,
): Segment | null {
  if (!isIndexed(addressing)) {
    if (isUnresolved(addressing)) return null;
    return (addressing as readonly Segment[]).find((segment) => segment.seq === seq) ?? null;
  }
  if (seq < addressing.startSeq) return null;
  if (addressing.endSeq !== null && seq > addressing.endSeq) return null;

  const { timescale } = addressing;
  const pto = addressing.presentationTimeOffset ?? 0;
  let startUnits: number;
  let durationUnits: number;
  if (addressing.timeline !== null) {
    let cursor = addressing.startSeq;
    let found: { start: number; duration: number } | null = null;
    for (const run of addressing.timeline) {
      if (seq < cursor + run.count) {
        found = { start: run.start + (seq - cursor) * run.duration, duration: run.duration };
        break;
      }
      cursor += run.count;
    }
    if (found === null) return null;
    startUnits = found.start;
    durationUnits = found.duration;
  } else if (addressing.segmentDuration !== null) {
    // Media time starts at the offset: the period's first segment carries
    // it, so $Time$ expands with it and the subtraction below lands at the
    // period start, not before it.
    durationUnits = addressing.segmentDuration;
    startUnits = pto + (seq - addressing.startSeq) * durationUnits;
  } else {
    return null;
  }

  // $Number$ and $Time$, with the ISO/IEC 23009-1 %0<width>d format tag,
  // then $$ unescaped last.
  const url = addressing.urlTemplate
    .replace(/\$(Number|Time)(?:%0(\d+)d)?\$/g, (_, name: string, width?: string) => {
      const text = String(name === 'Number' ? seq : startUnits);
      return width === undefined ? text : text.padStart(Number(width), '0');
    })
    .replaceAll('$$', '$');
  return {
    seq,
    start: periodStart + (startUnits - pto) / timescale,
    duration: durationUnits / timescale,
    url,
  };
}

/** The first segment whose interval contains or follows `time`, or null past the end. */
export function segmentAtTime(
  addressing: SegmentAddressing,
  time: number,
  periodStart = 0,
): Segment | null {
  if (!isIndexed(addressing)) {
    if (isUnresolved(addressing)) return null;
    for (const segment of addressing as readonly Segment[]) {
      if (segment.start + segment.duration > time) return segment;
    }
    return null;
  }
  // Constant-duration templates index directly; timelines scan their runs.
  if (addressing.timeline === null && addressing.segmentDuration !== null) {
    const dur = addressing.segmentDuration / addressing.timescale;
    const relative = Math.max(0, time - periodStart);
    const seq = addressing.startSeq + Math.floor(relative / dur);
    return segmentAt(addressing, Math.max(seq, addressing.startSeq), periodStart);
  }
  let seq = addressing.startSeq;
  const last = addressing.endSeq;
  while (last === null || seq <= last) {
    const segment = segmentAt(addressing, seq, periodStart);
    if (segment === null) return null;
    if (segment.start + segment.duration > time) return segment;
    seq += 1;
  }
  return null;
}

/**
 * The seekable window. VOD: zero to the announced or derivable duration.
 * Live: the sliding window ending at the supplied edge; the kernel never
 * computes the edge itself.
 */
export function seekableWindow(presentation: Presentation, liveEdge: number | null): TimeRange {
  if (!presentation.isLive) {
    if (presentation.duration !== undefined) return { start: 0, end: presentation.duration };
    let end = 0;
    for (const period of presentation.periods) {
      if (period.duration !== undefined) end = Math.max(end, period.start + period.duration);
    }
    return { start: 0, end };
  }
  const edge = liveEdge ?? 0;
  let windowStart = edge;
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        const addressing = rendition.segments;
        if (isIndexed(addressing)) {
          const first = segmentAt(addressing, addressing.startSeq, period.start);
          if (first !== null) windowStart = Math.min(windowStart, first.start);
        } else if (!isUnresolved(addressing)) {
          const first = (addressing as readonly Segment[])[0];
          if (first !== undefined) windowStart = Math.min(windowStart, first.start);
        }
      }
    }
  }
  return { start: Math.min(windowStart, edge), end: edge };
}
