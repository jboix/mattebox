/**
 * The sink contract. The scheduler is written against generic tracks and
 * does not know that SourceBuffers are the only possible destination; text
 * and metadata are pipelines beside audio and video, not post-processing.
 * This interface exists before any scheduler work on purpose: retrofitting
 * it is a rewrite.
 */
import type { ContentType, TimeRangesSnapshot, TrackId } from './ir.js';
import type { Effect, SegmentMeta } from './messages.js';

// SegmentMeta moved to messages.ts so the deliver effect can carry it
// without a module cycle; re-exported here for compatibility.
export type { SegmentMeta } from './messages.js';

/**
 * A destination for scheduled media. Sinks return effects rather than acting
 * directly so the append path stays inside the effect runner.
 *
 * The `ContentType` parameter ties a sink to the content type it was
 * registered for, so a text sink cannot be registered under 'video'.
 */
export interface Sink<C extends ContentType = ContentType> {
  readonly contentType: C;
  /** Accepts one segment's bytes and returns the effects that deliver them. */
  accept(trackId: TrackId, data: ArrayBuffer, meta: SegmentMeta): readonly Effect[];
  /** What this sink currently holds for the track, in presentation time. */
  ranges(trackId: TrackId): TimeRangesSnapshot;
  /** Returns the effects that discard the given window. */
  clear(trackId: TrackId, start: number, end: number): readonly Effect[];
}
