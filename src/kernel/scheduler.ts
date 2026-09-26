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
import {
  buildEpochs,
  epochForSeq,
  epochKey,
  segmentAtTime,
  timestampOffsetFor,
} from './timeline.js';

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
  /** The media segments the track's buffer received since the last seek, when the buffer knows. */
  readonly appended?: ReadonlyArray<{ readonly renditionId: string; readonly seq: number }>;
}

export interface ScheduleInput {
  readonly currentTime: number;
  /** The presentation's duration, for VOD: a playhead at the very end still needs the last segment. */
  readonly duration?: number;
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
   * Whether the composition reads decode times from media bytes (a time
   * probe is registered). Then the first segment to land in an epoch
   * settles its offset for every buffer, and the lead track should be that
   * segment: a companion track holds its media fetch while the lead has one
   * pending in an unsettled epoch. videojs-http-streaming's audio loader
   * waits for the main loader's timeline change the same way.
   */
  readonly reconciles?: boolean;
  /** The buffer whose bytes settle an epoch first: video when present, else audio. */
  readonly leadSbId?: SbId;
  /** The epochs already settled, by name. */
  readonly reconciled?: ReadonlyMap<string, number>;
  /** True while the lead track has an init or media request in flight, or one about to be issued. */
  readonly leadPending?: boolean;
}

export interface ScheduleResult {
  readonly effects: readonly Effect[];
  readonly requests: readonly InflightRequest[];
  readonly tokenSeq: number;
}

const DEFAULT_GAP_TOLERANCE = 0.25;

/**
 * A playhead this close to the end counts as inside the last segment. No
 * segment starts at the duration itself, so a seek to the very end would
 * otherwise find nothing to fetch there.
 */
export const END_SLACK = 0.5;

/** Where the buffer is measured from: the playhead, or just inside the last segment when it sits at the end. */
export function measuredFrom(time: number, duration: number | undefined): number {
  return duration === undefined ? time : Math.min(time, duration - END_SLACK);
}

/**
 * Whether `ranges` hold media from the playhead through to `duration`. The
 * playhead alone never counts: a seek to the end with nothing buffered there
 * has not reached it, and ending the stream then would cut the duration
 * down to what is buffered (W3C Media Source Extensions, endOfStream).
 */
export function reachesEnd(
  ranges: TimeRangesSnapshot,
  time: number,
  duration: number,
  tolerance: number,
): boolean {
  const from = measuredFrom(time, duration);
  const inside = ranges.some((range) => range.start <= from + tolerance && range.end > from);
  return inside && bufferedEndFrom(ranges, from, tolerance) >= duration - END_SLACK;
}

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

/** Whether the track's buffer received `seq` of the track's rendition since the last seek. */
function received(track: ScheduleTrackInput, seq: number): boolean {
  const id = track.rendition.id;
  return track.appended?.some((entry) => entry.seq === seq && entry.renditionId === id) === true;
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

    const now = measuredFrom(input.currentTime, input.duration);
    const bufferedEnd = bufferedEndFrom(track.ranges, now, tolerance);
    if (bufferedEnd - now >= input.bufferGoal) continue;

    let target = Math.max(bufferedEnd, now);
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
      let covering = coveringSegment(track.ranges, segment, tolerance);
      if (covering === null && received(track, segment.seq)) {
        // The buffer received this very segment and shows no usable range
        // for it: a packager cut it so far off the GOP grid that MSE kept
        // a sliver or nothing. Fetching it again returns the same bytes
        // and the same sliver, would trip the repeat breaker, and would
        // re-append over the frames that followed it, which MSE then drops
        // back to their next keyframe. The walk moves past it, to whatever
        // it did leave; the hole is recovery's.
        const { start, duration } = segment;
        const left = track.ranges.find(
          (range) => range.start >= start && range.start < start + duration,
        );
        covering = { start, end: left?.end ?? start + duration };
      }
      if (covering === null) break;
      frontier = Math.max(frontier, covering.end);
      if (frontier - now >= input.bufferGoal) {
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
    const key = epoch === null ? undefined : epochKey(epochs, epoch);
    if (
      input.reconciles === true &&
      key !== undefined &&
      track.sbId !== undefined &&
      track.sbId !== input.leadSbId &&
      input.reconciled?.has(key) !== true &&
      (input.leadPending === true || requests.some((r) => r.sbId === input.leadSbId))
    ) {
      // The lead's segment settles this epoch; the next driving fact
      // reschedules this track once it has.
      continue;
    }

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
      ...(epoch !== null ? { timestampOffset: timestampOffsetFor(epoch) } : {}),
      ...(key !== undefined ? { epoch: key } : {}),
    });
  }

  return { effects, requests, tokenSeq };
}
