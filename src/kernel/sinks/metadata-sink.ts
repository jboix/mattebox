/**
 * Timed metadata (ID3, emsg, DATERANGE) as cues on a metadata TextTrack.
 * Same machinery as text: metadata is a pipeline, not a special case.
 */
import type { CueSink, CueSinkDeps } from './text-track-sink.js';
import { createCueSink } from './text-track-sink.js';

export function createMetadataSink(deps: CueSinkDeps): CueSink<'metadata'> {
  return createCueSink('metadata', 'metadata', deps);
}
