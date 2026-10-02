/**
 * TTML subtitles as a stage, for the IMSC1 Text Profile and EBU-TT-D. It
 * joins the one text sink with two formats:
 *
 * - `application/ttml+xml`: a whole document per segment, a sidecar for the
 *   period or one file per segment, timed on the presentation timeline.
 * - `application/mp4;stpp`: TTML in fMP4 (ISO/IEC 14496-30), one document
 *   per sample. The document's times are on the track's media timeline, so
 *   they map through the segment's decode time, which lands at the
 *   segment's start. Some packagers time each document from its sample's
 *   start instead; a document whose times fall before its sample is read
 *   that way.
 *
 * Italics, bold, and underline show; the region places the cue. Colors do
 * not: a VTTCue carries them only through page CSS, which the engine does
 * not write. Each cue's `payload` holds its resolved styles, for a player
 * that draws captions itself.
 */
import { fragmentSamples, trackTimescales } from '../../containers/mp4-box/index.js';
import { joinTextSink } from '../../kernel/sinks/text-formats.js';
import type { CueDescriptor } from '../../types/messages.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';
import { parseTtml } from './parse.js';

const TTML = 'application/ttml+xml';

/** The cues with open ends closed at `end`, and an id for each, so a refetched segment adds nothing twice. */
function finish(cues: readonly CueDescriptor[], shift: number, end: number): CueDescriptor[] {
  return cues.map((cue) => {
    const start = cue.start + shift;
    const stop = Math.min(cue.end + shift, end);
    return { ...cue, id: `${start.toFixed(3)}|${stop.toFixed(3)}|${cue.text}`, start, end: stop };
  });
}

function parseDocument(data: Uint8Array, meta: SegmentMeta): readonly CueDescriptor[] {
  return finish(parseTtml(new TextDecoder().decode(data)), 0, meta.start + meta.duration);
}

export default function textTtml(): Stage {
  return {
    name: 'text-ttml',
    provides: [
      'text-ttml',
      { contentType: 'text', mimeType: TTML },
      { contentType: 'text', mimeType: 'application/mp4', codecs: 'stpp' },
    ],
    requires: ['scheduler'],
    install(ctx) {
      // Track timescales from each rendition's init, for the sample times.
      const timescales = new Map<string, ReadonlyMap<number, number>>();

      function parseStpp(data: Uint8Array, meta: SegmentMeta): readonly CueDescriptor[] {
        if (meta.isInit) {
          timescales.set(meta.renditionId, trackTimescales(data));
          return [];
        }
        const scales = timescales.get(meta.renditionId);
        const cues: CueDescriptor[] = [];
        for (const fragment of fragmentSamples(data)) {
          const scale = scales?.get(fragment.trackId);
          const first = fragment.samples[0];
          if (scale === undefined || first === undefined) continue;
          // The segment's first decode time lands at its start.
          const shift = meta.start - first.decodeTime / scale;
          for (const sample of fragment.samples) {
            if (sample.offset + sample.size > data.byteLength) continue;
            const from = sample.decodeTime / scale;
            const to = (sample.decodeTime + sample.duration) / scale;
            const parsed = parseTtml(
              new TextDecoder().decode(data.subarray(sample.offset, sample.offset + sample.size)),
            );
            const relative = parsed.some((cue) => cue.start < from - 0.5);
            cues.push(...finish(parsed, relative ? shift + from : shift, to + shift));
          }
        }
        return cues;
      }

      return joinTextSink(ctx, { [TTML]: parseDocument, 'application/mp4;stpp': parseStpp });
    },
  };
}
