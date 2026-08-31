/**
 * The first Sink implementation: audio and video bytes to SourceBuffers.
 * The sink returns effects rather than touching MSE itself, so the append
 * path stays inside the effect runner and the trace.
 */
import type { ContentType, TimeRangesSnapshot, TrackId } from '../../types/ir.js';
import type { SbId } from '../../types/kernel.js';
import type { Effect } from '../../types/messages.js';
import type { Sink } from '../../types/sink.js';

export type MediaContentType = Extract<ContentType, 'audio' | 'video'>;

/** The sbId naming convention: one SourceBuffer per media content type. */
export function sbIdFor(contentType: MediaContentType): SbId {
  return `sb:${contentType}`;
}

export interface MseSinkDeps {
  /** Real SourceBuffer ranges, provided by the mse controller. */
  buffered(sbId: SbId): TimeRangesSnapshot;
}

export function createMseSink<C extends MediaContentType>(
  contentType: C,
  deps: MseSinkDeps,
): Sink<C> {
  const sbId = sbIdFor(contentType);
  return {
    contentType,
    accept(_trackId: TrackId, data: ArrayBuffer): readonly Effect[] {
      return [{ kind: 'append', sbId, data }];
    },
    ranges(_trackId: TrackId): TimeRangesSnapshot {
      return deps.buffered(sbId);
    },
    clear(_trackId: TrackId, start: number, end: number): readonly Effect[] {
      return [{ kind: 'remove', sbId, start, end }];
    },
  };
}
