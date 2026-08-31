/**
 * CEA-608 in-band captions as a stage. It owns the decoder and the seam to
 * its SEI source: it registers one caption consumer, and whichever source is
 * composed (ts-transmux for TS, nal-scan for fMP4) delivers the byte pairs.
 * The stage imports neither source, only the shared registry, which is what
 * lets one decoder serve both routes (entanglement #1).
 *
 * Decoded captions become native VTTCues on a caption TextTrack, rendered by
 * the browser like any text track. The track is created on the first cue and
 * left off by default; the viewer or the app turns it on.
 */
import { registerCaptionConsumer } from '../../containers/captions.js';
import type { Stage } from '../../types/stage.js';
import { Cea608Decoder } from './decode.js';

// A minimal VTTCue view; the DOM lib's shape without pulling it in here.
type CueCtor = new (start: number, end: number, text: string) => object;

export default function textCea608(): Stage {
  return {
    name: 'text-cea608',
    provides: ['text-cea608', { contentType: 'text', mimeType: 'application/cea-608' }],
    // Either SEI source satisfies it; the loader resolves the alternative.
    requires: [['ts-transmux', 'nal-scan']],
    install(ctx) {
      const decoder = new Cea608Decoder();
      const element = ctx.element;
      let track: TextTrack | null = null;

      /** Empties the track. `cues` reads null while disabled; hidden makes them removable. */
      function empty(target: TextTrack): void {
        target.mode = 'hidden';
        const { cues } = target;
        if (cues === null) return;
        for (let i = cues.length - 1; i >= 0; i -= 1) {
          const cue = cues[i];
          if (cue !== undefined) target.removeCue(cue);
        }
      }

      function ensureTrack(): TextTrack {
        if (track === null) {
          // The element cannot drop a TextTrack, so a previous attach on the
          // same element (a rebuild) left one behind: adopt it, emptied,
          // rather than add a duplicate to the browser's caption menu.
          for (const existing of element.textTracks) {
            if (existing.kind === 'captions' && existing.label === 'CC1') {
              track = existing;
              empty(track);
              break;
            }
          }
          track ??= element.addTextTrack('captions', 'CC1', 'en');
          // Present but not rendered until the viewer selects it.
          track.mode = 'hidden';
        }
        return track;
      }

      const unregister = registerCaptionConsumer((packets) => {
        for (const packet of packets) {
          for (const triple of packet.triples) {
            // CEA-608 field 1 carries CC1, the primary channel this decodes.
            if (triple.type === 0) decoder.push(triple.a, triple.b, packet.time);
          }
        }
        const cues = decoder.drain();
        if (cues.length === 0) return;
        const VttCue = (globalThis as { VTTCue?: CueCtor }).VTTCue;
        if (VttCue === undefined) return;
        const target = ensureTrack();
        for (const cue of cues) {
          target.addCue(new VttCue(cue.start, cue.end, cue.text) as unknown as TextTrackCue);
        }
      });

      return () => {
        unregister();
        if (track !== null) {
          empty(track);
          track.mode = 'disabled';
          track = null;
        }
      };
    },
  };
}
