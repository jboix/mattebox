/**
 * WebVTT as a stage: the parser for `text/vtt`, joined to the one text sink
 * every subtitle format shares (`kernel/sinks/text-formats.ts`). Cues become
 * native VTTCues; the browser renders, styles, and exposes the caption UI,
 * which is why this stage stays small. It mirrors only its own format's
 * tracks; the in-band caption stages fill caption tracks of their own.
 */

import { parseVtt } from '../../containers/webvtt.js';
import { joinTextSink } from '../../kernel/sinks/text-formats.js';
import type { CueDescriptor } from '../../types/messages.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

const MIME = 'text/vtt';

function parseSegment(data: Uint8Array, _meta: SegmentMeta): readonly CueDescriptor[] {
  return parseVtt(new TextDecoder().decode(data)).cues;
}

export default function textWebvtt(): Stage {
  return {
    name: 'text-webvtt',
    provides: ['text-webvtt', { contentType: 'text', mimeType: MIME }],
    requires: ['scheduler'],
    install(ctx) {
      return joinTextSink(ctx, { [MIME]: parseSegment });
    },
  };
}
