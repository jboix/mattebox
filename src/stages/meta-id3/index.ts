/**
 * ID3 timed metadata as cues. A metadata rendition whose segments are ID3,
 * or a packed-audio segment's leading ID3 tag, becomes zero-length cues on a
 * metadata TextTrack through the same MetadataSink the emsg and DATERANGE
 * paths use. The ID3 decoding itself lives in the container layer so this
 * stage and packed-audio share it without importing each other.
 *
 * It requires `media-transform`, which ts-transmux and packed-audio both
 * provide: ID3 only reaches the engine once one of them is decoding the
 * legacy segments it rides in.
 */

import { id3Cues } from '../../containers/id3.js';
import { createMetadataSink } from '../../kernel/sinks/metadata-sink.js';
import type { CueDescriptor } from '../../types/messages.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

function parseId3Segment(data: Uint8Array, meta: SegmentMeta): readonly CueDescriptor[] {
  // The segment's presentation start times every cue; a zero-length cue is
  // how a point-in-time metadata event is represented.
  return id3Cues(data, meta.start);
}

export default function metaId3(): Stage {
  return {
    name: 'meta-id3',
    provides: ['meta-id3', { contentType: 'metadata', mimeType: 'application/id3' }],
    requires: ['media-transform'],
    install(ctx) {
      ctx.registerParser('application/id3', parseId3Segment);
      ctx.registerSink('metadata', ({ element }) =>
        createMetadataSink({ element, parse: parseId3Segment, label: 'ID3' }),
      );
    },
  };
}
