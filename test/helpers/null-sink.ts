import type {
  ContentType,
  Effect,
  SegmentMeta,
  Sink,
  TimeRange,
  TimeRangesSnapshot,
  TrackId,
} from '../../src/index.js';

/**
 * A sink that goes nowhere, used to prove the scheduler is sink-agnostic:
 * it emits the same effect shapes as MseSink and reports ranges from its
 * own ledger. If the scheduler behaves differently against this than
 * against MseSink with equal ranges, the abstraction has a leak.
 */
export interface NullSink<C extends ContentType> extends Sink<C> {
  readonly accepted: ReadonlyArray<{ trackId: TrackId; meta: SegmentMeta; bytes: number }>;
  /** Simulates what a real buffer would report after the appends land. */
  settle(): void;
}

export function createNullSink<C extends ContentType>(contentType: C, sbId?: string): NullSink<C> {
  const accepted: Array<{ trackId: TrackId; meta: SegmentMeta; bytes: number }> = [];
  const settled = new Map<TrackId, TimeRange[]>();
  let unsettled: Array<{ trackId: TrackId; range: TimeRange }> = [];

  return {
    contentType,
    accepted,
    accept(trackId, data, meta): readonly Effect[] {
      accepted.push({ trackId, meta, bytes: data.byteLength });
      if (!meta.isInit) {
        unsettled.push({ trackId, range: { start: meta.start, end: meta.start + meta.duration } });
      }
      if (sbId !== undefined) {
        return [{ kind: 'append', sbId, data }];
      }
      return [];
    },
    ranges(trackId): TimeRangesSnapshot {
      return settled.get(trackId) ?? [];
    },
    clear(trackId, start, end): readonly Effect[] {
      const ranges = settled.get(trackId) ?? [];
      settled.set(
        trackId,
        ranges.flatMap((range) => {
          if (range.end <= start || range.start >= end) return [range];
          const kept: TimeRange[] = [];
          if (range.start < start) kept.push({ start: range.start, end: start });
          if (range.end > end) kept.push({ start: end, end: range.end });
          return kept;
        }),
      );
      if (sbId !== undefined) {
        return [{ kind: 'remove', sbId, start, end }];
      }
      return [];
    },
    settle() {
      for (const { trackId, range } of unsettled) {
        const ranges = settled.get(trackId) ?? [];
        const merged: TimeRange[] = [];
        let pending = range;
        for (const existing of ranges) {
          if (existing.end < pending.start || existing.start > pending.end) {
            merged.push(existing);
          } else {
            pending = {
              start: Math.min(existing.start, pending.start),
              end: Math.max(existing.end, pending.end),
            };
          }
        }
        merged.push(pending);
        settled.set(
          trackId,
          merged.sort((a, b) => a.start - b.start),
        );
      }
      unsettled = [];
    },
  };
}
