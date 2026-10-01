/**
 * CEA-608 in-band captions as a stage. It owns the decoder and the seam to
 * its SEI source: it registers one caption consumer, and whichever source is
 * composed (ts-transmux for TS, nal-scan for fMP4) delivers the byte pairs.
 * The stage imports neither source, only the shared registry, which is what
 * lets one decoder serve both routes (entanglement #1).
 *
 * The captions are a text track like any subtitle: selectable through
 * `engine.tracks`, and listed in a player's menu. The manifest declares the
 * track (HLS CLOSED-CAPTIONS, DASH cea-608 Accessibility). A stream that
 * declares none gets one added on its first cue (ADD_TRACK). The decoder
 * reads CC1, so the stage plays the CC1 track.
 *
 * Decoded captions become native VTTCues on a caption TextTrack, rendered by
 * the browser. The stage keeps that track and the engine's text selection
 * in step, both ways, as text-webvtt does for its own tracks: showing while
 * the caption track is selected, hidden otherwise, so cues keep arriving.
 */

import { registerCaptionConsumer } from '../../containers/captions.js';
import { adoptTextTrack, emptyTextTrack } from '../../kernel/sinks/text-track-sink.js';
import type { Track } from '../../types/ir.js';
import type { Stage } from '../../types/stage.js';
import { Cea608Decoder } from './decode.js';

// A minimal VTTCue view; the DOM lib's shape without pulling it in here.
type CueCtor = new (start: number, end: number, text: string) => object;

const MIME = 'application/cea-608';
/** The channel the decoder reads: field 1, channel 1. */
const CHANNEL = 'CC1';

/** The track a stream gets when its manifest declares no captions. */
const ADDED: Track = {
  id: 'cea608:CC1',
  contentType: 'text',
  mimeType: MIME,
  protection: null,
  role: 'caption',
  instreamId: CHANNEL,
  renditions: [],
};

export default function textCea608(): Stage {
  return {
    name: 'text-cea608',
    provides: ['text-cea608', { contentType: 'text', mimeType: MIME }],
    // Either SEI source satisfies it; the loader resolves the alternative.
    // nal-scan comes first because it reads fMP4, which every preset plays.
    requires: [['nal-scan', 'ts-transmux']],
    install(ctx) {
      const decoder = new Cea608Decoder();
      const element = ctx.element;
      let native: TextTrack | null = null;
      let adding = false;

      /** The CC1 caption track of the presentation, declared or added. */
      function captionTrack(): Track | null {
        for (const period of ctx.getState().presentation?.periods ?? []) {
          for (const track of period.tracks) {
            if (track.mimeType === MIME && track.instreamId === CHANNEL) return track;
          }
        }
        return null;
      }

      function selected(track: Track | null): boolean {
        return track !== null && ctx.getState().tracks.active.get('text') === track.id;
      }

      /** The native track, created on first need. Hidden keeps cues arriving and removable. */
      function ensureNative(): TextTrack {
        if (native === null) {
          native = adoptTextTrack(element, 'captions', CHANNEL, captionTrack()?.lang);
          native.mode = 'hidden';
        }
        return native;
      }

      // Engine to element.
      function mirror(): void {
        const showing = selected(captionTrack());
        if (native === null && !showing) return;
        const target = ensureNative();
        const mode = showing ? 'showing' : 'hidden';
        if (target.mode !== mode) target.mode = mode;
      }

      // Element to engine: a pick in the browser's caption menu. Fires for
      // the mirror's own writes too; those find the engine in step.
      function onNativeChange(): void {
        const track = captionTrack();
        if (native === null || track === null) return;
        const on = native.mode === 'showing';
        if (on && !selected(track)) ctx.dispatch({ type: 'SELECT_TRACK', trackId: track.id });
        else if (!on && selected(track))
          ctx.dispatch({ type: 'DESELECT_TRACK', contentType: 'text' });
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
        // Captions the manifest did not declare: the media reveals the track.
        if (captionTrack() === null && !adding && ctx.getState().presentation !== null) {
          adding = true;
          ctx.dispatch({ type: 'ADD_TRACK', track: ADDED });
        }
        const VttCue = (globalThis as { VTTCue?: CueCtor }).VTTCue;
        if (VttCue === undefined) return;
        const target = ensureNative();
        for (const cue of cues) {
          target.addCue(new VttCue(cue.start, cue.end, cue.text) as unknown as TextTrackCue);
        }
      });

      const offChanged = ctx.on('tracks:changed', () => {
        // A new source has no added track until its own first cue.
        if (captionTrack() === null) adding = false;
        mirror();
      });
      const offSelected = ctx.on('tracks:selected', (payload) => {
        if ((payload as { contentType?: string }).contentType === 'text') mirror();
      });
      element.textTracks.addEventListener('change', onNativeChange);

      return () => {
        unregister();
        offChanged();
        offSelected();
        element.textTracks.removeEventListener('change', onNativeChange);
        if (native !== null) {
          emptyTextTrack(native);
          native.mode = 'disabled';
          native = null;
        }
      };
    },
  };
}
