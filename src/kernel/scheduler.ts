/**
 * The buffer-goal loop: given what each track's sink holds and where the
 * playhead is, decide what to fetch next. Written against generic tracks
 * and the Sink range contract only. This module must never know what
 * kind of buffer sits behind a sink; text is a peer pipeline, not a
 * special case.
 *
 * Pure: the caller supplies every input, including the live window when a
 * live stage owns edge computation. Output is fetch effects plus the
 * in-flight records to store.
 */
import type { Period, Rendition, TimeRange, TimeRangesSnapshot, TrackId } from '../types/ir.js';
import type { InflightRequest, SbId } from '../types/kernel.js';
import type { Effect } from '../types/messages.js';
import { buildEpochs, epochForSeq, segmentAtTime, timestampOffsetFor } from './timeline.js';

export interface ScheduleTrackInput {
  readonly trackId: TrackId;
  readonly period: Period;
  readonly rendition: Rendition;
  /** What this track's sink currently holds. The only buffer knowledge used. */
  readonly ranges: TimeRangesSnapshot;
  /** Destination for media sinks; text and metadata tracks have none. */
  readonly sbId?: SbId;
  /** This track's requests already in flight. */
  readonly inflight: readonly InflightRequest[];
}

export interface ScheduleInput {
  readonly currentTime: number;
  /** Seconds of forward buffer to maintain. */
  readonly bufferGoal: number;
  /** Continues the state counter so tokens stay unique. */
  readonly tokenSeq: number;
  readonly tracks: readonly ScheduleTrackInput[];
  /** Sliding availability window from a live stage; null for VOD. */
  readonly liveWindow?: TimeRange | null;
  /**
   * Gap width treated as continuous. Browsers coalesce and round appended
   * ranges, so exact arithmetic against what was appended misfires.
   */
  readonly gapToleranceSeconds?: number;
  /**
   * A transform rewrites each segment's decode time to its presentation
   * start, so every append takes a zero timestampOffset. See KernelConfig.
   */
  readonly mediaTimeNormalized?: boolean;
}

export interface ScheduleResult {
  readonly effects: readonly Effect[];
  readonly requests: readonly InflightRequest[];
  readonly tokenSeq: number;
}

const DEFAULT_GAP_TOLERANCE = 0.25;

/**
 * The end of continuous buffer from `time`, merging gaps below the
 * tolerance. Returns `time` itself when nothing is buffered there.
 */
export function bufferedEndFrom(
  ranges: TimeRangesSnapshot,
  time: number,
  tolerance: number,
): number {
  let end = time;
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const range of ranges) {
      if (range.start <= end + tolerance && range.end > end) {
        end = range.end;
        advanced = true;
      }
    }
  }
  return end;
}

/**
 * The buffered range that shows the segment was appended, or null. Either
 * its midpoint is buffered, or its tail is: a segment whose first keyframe
 * sits past its midpoint (a packager that cut segments off the GOP grid)
 * appends as a range starting at that keyframe, because MSE drops the
 * leading frames it cannot decode (ISO 23009-1 and the MSE coded frame
 * processing algorithm, "need random access point flag").
 */
function coveringSegment(
  ranges: TimeRangesSnapshot,
  segment: { start: number; duration: number },
  tolerance: number,
): { start: number; end: number } | null {
  const mid = segment.start + segment.duration / 2;
  const tail = Math.max(mid, segment.start + segment.duration - tolerance);
  return (
    ranges.find(
      (range) =>
        (range.start <= mid && range.end > mid) || (range.start <= tail && range.end >= tail),
    ) ?? null
  );
}

export function schedule(input: ScheduleInput): ScheduleResult {
  const tolerance = input.gapToleranceSeconds ?? DEFAULT_GAP_TOLERANCE;
  const effects: Effect[] = [];
  const requests: InflightRequest[] = [];
  let tokenSeq = input.tokenSeq;

  for (const track of input.tracks) {
    // One request per track at a time. A burst would race itself: the next
    // decision is better made once this segment's bytes have arrived.
    if (track.inflight.length > 0) continue;

    const bufferedEnd = bufferedEndFrom(track.ranges, input.currentTime, tolerance);
    if (bufferedEnd - input.currentTime >= input.bufferGoal) continue;

    let target = Math.max(bufferedEnd, input.currentTime);
    if (input.liveWindow != null && target < input.liveWindow.start) {
      // The window slid past this position; resume at its start.
      target = input.liveWindow.start;
    }

    let segment = segmentAtTime(track.rendition.segments, target + tolerance, track.period.start);
    // Media shorter than its playlist entry (an ad pod's last segment whose
    // audio was cut early, say) leaves a hole the run cannot cross, inside
    // or right after a segment already appended. Fetching that segment again
    // cannot close the hole and would trip the repeat breaker. A segment
    // whose midpoint or tail is buffered counts as consumed: the walk moves
    // past it and past anything buffered beyond the hole, up to the goal,
    // and the hole itself is recovery's to jump.
    let frontier = bufferedEnd;
    while (segment !== null) {
      const covering = coveringSegment(track.ranges, segment, tolerance);
      if (covering === null) break;
      frontier = Math.max(frontier, covering.end);
      if (frontier - input.currentTime >= input.bufferGoal) {
        segment = null;
        break;
      }
      segment = segmentAtTime(
        track.rendition.segments,
        segment.start + segment.duration + tolerance,
        track.period.start,
      );
    }
    if (segment === null) continue;
    if (input.liveWindow != null && segment.start + segment.duration > input.liveWindow.end) {
      // Not fully available yet. The next window update reschedules it.
      continue;
    }

    const epochs = buildEpochs([{ period: track.period, rendition: track.rendition }]);
    const epoch = epochForSeq(epochs, segment.seq);

    tokenSeq += 1;
    const token = `t${tokenSeq}:${track.trackId}:${segment.seq}`;
    effects.push({
      kind: 'fetch',
      token,
      url: segment.url,
      ...(segment.byteRange !== undefined ? { range: segment.byteRange } : {}),
    });
    requests.push({
      token,
      trackId: track.trackId,
      seq: segment.seq,
      url: segment.url,
      renditionId: track.rendition.id,
      segmentStart: segment.start,
      segmentDuration: segment.duration,
      ...(track.sbId !== undefined ? { sbId: track.sbId } : {}),
      ...(input.mediaTimeNormalized === true
        ? { timestampOffset: 0 }
        : epoch !== null
          ? { timestampOffset: timestampOffsetFor(epoch) }
          : {}),
    });
  }

  return { effects, requests, tokenSeq };
}
