/**
 * WebVTT in fMP4 (ISO/IEC 14496-30 §7). Each sample covers a span of time
 * and holds one `vttc` box per cue shown over that span, with the cue text
 * (`payl`) and its settings (`sttg`); a `vtte` box marks a
 * span with no cue. A cue longer than one sample repeats in each, so equal
 * cues in adjacent samples join into one.
 */
import type { CueDescriptor } from '../types/messages.js';
import { fourcc, type TimedSample, viewOf } from './mp4-box/index.js';

/** The child boxes of `bytes`, as type and payload. */
function boxes(bytes: Uint8Array): Array<[string, Uint8Array]> {
  const out: Array<[string, Uint8Array]> = [];
  const view = viewOf(bytes);
  for (let offset = 0; offset + 8 <= bytes.byteLength; ) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > bytes.byteLength) break;
    out.push([fourcc(bytes, offset + 4), bytes.subarray(offset + 8, offset + size)]);
    offset += size;
  }
  return out;
}

/** The cues of a wvtt segment's samples, joined across samples. */
export function wvttCues(samples: readonly TimedSample[]): CueDescriptor[] {
  const decoder = new TextDecoder();
  const cues: CueDescriptor[] = [];
  for (const sample of samples) {
    for (const [type, payload] of boxes(sample.bytes)) {
      if (type !== 'vttc') continue;
      const parts = new Map(boxes(payload).map(([name, body]) => [name, decoder.decode(body)]));
      const text = parts.get('payl') ?? '';
      const settings = parts.get('sttg');
      const joined = cues.find(
        (cue) => cue.end === sample.start && cue.text === text && cue.settings === settings,
      );
      if (joined !== undefined) {
        cues[cues.indexOf(joined)] = { ...joined, end: sample.end };
        continue;
      }
      cues.push({
        start: sample.start,
        end: sample.end,
        text,
        ...(settings !== undefined && settings !== '' ? { settings } : {}),
      });
    }
  }
  // Re-delivered segments re-emit their cues; an id lets the sink skip them.
  // Not the iden: a cue crossing a segment boundary repeats it in both.
  return cues.map((cue) => ({
    ...cue,
    id: `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|${cue.text}`,
  }));
}
