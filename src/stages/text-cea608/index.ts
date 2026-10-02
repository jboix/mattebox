/**
 * CEA-608 in-band captions as a stage. It owns the decoder and the seam to
 * its SEI source: it registers one caption consumer, and whichever source is
 * composed (ts-transmux for TS, nal-scan for fMP4) delivers the byte pairs.
 * The stage imports neither source, only the shared registry, which is what
 * lets one decoder serve both routes (entanglement #1).
 *
 * The four caption channels are text tracks like any subtitle: selectable
 * through `engine.tracks`, and listed in a player's menu. Field 1 carries CC1
 * and CC2, field 2 carries CC3 and CC4. The manifest declares the tracks
 * (HLS CLOSED-CAPTIONS, DASH cea-608 Accessibility). A channel the manifest
 * does not declare gets a track added on its first cue (ADD_TRACK).
 *
 * Decoded captions become native VTTCues on one caption TextTrack per
 * channel, labelled CC1 to CC4, rendered by the browser. The tracks and
 * their sync with the engine's selection are shared with text-cea708
 * (`kernel/sinks/caption-tracks.ts`).
 */

import { registerCaptionConsumer } from '../../containers/captions.js';
import { inbandCaptions, vttCue } from '../../kernel/sinks/caption-tracks.js';
import type { Stage } from '../../types/stage.js';
import { Cea608Field, type Cue } from './decode.js';

const MIME = 'application/cea-608';

export default function textCea608(): Stage {
  return {
    name: 'text-cea608',
    provides: ['text-cea608', { contentType: 'text', mimeType: MIME }],
    // Either SEI source satisfies it; the loader resolves the alternative.
    // nal-scan comes first because it reads fMP4, which every preset plays.
    requires: [['nal-scan', 'ts-transmux']],
    install(ctx) {
      // cc_type 0 is field 1 (CC1, CC2), cc_type 1 is field 2 (CC3, CC4).
      const fields = [new Cea608Field(), new Cea608Field()] as const;
      const captions = inbandCaptions(ctx, MIME, 'cea608');

      function show(channel: string, cues: readonly Cue[]): void {
        const native: TextTrackCue[] = [];
        for (const cue of cues) {
          const made = vttCue(cue.start, cue.end, cue.text);
          if (made !== null) native.push(made);
        }
        captions.show(channel, native);
      }

      const unregister = registerCaptionConsumer((packets) => {
        for (const packet of packets) {
          for (const triple of packet.triples) {
            // Types 2 and 3 are CEA-708 packet data, for text-cea708.
            if (triple.type === 0 || triple.type === 1) {
              fields[triple.type].push(triple.a, triple.b, packet.time);
            }
          }
        }
        const [field1, field2] = [fields[0].drain(), fields[1].drain()];
        show('CC1', field1[1]);
        show('CC2', field1[2]);
        show('CC3', field2[1]);
        show('CC4', field2[2]);
      });

      return () => {
        unregister();
        captions.dispose();
      };
    },
  };
}
