/**
 * WebVTT as a stage: the parsers for `text/vtt` files and for WebVTT in
 * fMP4 (`wvtt`, ISO/IEC 14496-30), joined to the one text sink
 * every subtitle format shares (`kernel/sinks/text-formats.ts`). Cues become
 * native VTTCues; the browser renders, styles, and exposes the caption UI,
 * which is why this stage stays small. It mirrors only its own format's
 * tracks; the in-band caption stages fill caption tracks of their own.
 */

import { timedSamples, trackTimescales } from '../../containers/mp4-box/index.js';
import { parseVtt } from '../../containers/webvtt.js';
import { wvttCues } from '../../containers/wvtt.js';
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
    provides: [
      'text-webvtt',
      { contentType: 'text', mimeType: MIME },
      { contentType: 'text', mimeType: 'application/mp4', codecs: 'wvtt' },
    ],
    requires: ['scheduler'],
    install(ctx) {
      // Track timescales from each wvtt rendition's init, for the sample times.
      const timescales = new Map<string, ReadonlyMap<number, number>>();
      function parseWvtt(data: Uint8Array, meta: SegmentMeta): readonly CueDescriptor[] {
        if (meta.isInit) {
          timescales.set(meta.renditionId, trackTimescales(data));
          return [];
        }
        return wvttCues(timedSamples(data, timescales.get(meta.renditionId), meta.start));
      }
      return joinTextSink(ctx, { [MIME]: parseSegment, 'application/mp4;wvtt': parseWvtt });
    },
  };
}
