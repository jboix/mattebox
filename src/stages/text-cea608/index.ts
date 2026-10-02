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
 * channel, labelled CC1 to CC4, rendered by the browser. The stage keeps
 * those tracks and the engine's text selection in step, both ways, as
 * text-webvtt does for its own tracks: showing while the channel's track is
 * selected, hidden otherwise, so cues keep arriving.
 */

import { registerCaptionConsumer } from '../../containers/captions.js';
import { adoptTextTrack, emptyTextTrack } from '../../kernel/sinks/text-track-sink.js';
import type { Track } from '../../types/ir.js';
import type { Stage } from '../../types/stage.js';
import { Cea608Field, type Cue } from './decode.js';

// A minimal VTTCue view; the DOM lib's shape without pulling it in here.
type CueCtor = new (start: number, end: number, text: string) => object;

const MIME = 'application/cea-608';
const CHANNELS = ['CC1', 'CC2', 'CC3', 'CC4'] as const;
type Channel = (typeof CHANNELS)[number];

/** The track a channel gets when the manifest does not declare it. */
function added(channel: Channel): Track {
  return {
    id: `cea608:${channel}`,
    contentType: 'text',
    mimeType: MIME,
    protection: null,
    role: 'caption',
    instreamId: channel,
    renditions: [],
  };
}

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
      const element = ctx.element;
      const natives = new Map<Channel, TextTrack>();
      const adding = new Set<Channel>();

      /** The channel's caption track in the presentation, declared or added. */
      function captionTrack(channel: Channel): Track | null {
        for (const period of ctx.getState().presentation?.periods ?? []) {
          for (const track of period.tracks) {
            if (track.mimeType === MIME && track.instreamId === channel) return track;
          }
        }
        return null;
      }

      function selected(track: Track | null): boolean {
        return track !== null && ctx.getState().tracks.active.get('text') === track.id;
      }

      /** The channel's native track, created on first need. Hidden keeps cues arriving and removable. */
      function ensureNative(channel: Channel): TextTrack {
        let native = natives.get(channel);
        if (native === undefined) {
          native = adoptTextTrack(element, 'captions', channel, captionTrack(channel)?.lang);
          native.mode = 'hidden';
          natives.set(channel, native);
        }
        return native;
      }

      // Engine to element.
      function mirror(): void {
        for (const channel of CHANNELS) {
          const showing = selected(captionTrack(channel));
          if (!natives.has(channel) && !showing) continue;
          const target = ensureNative(channel);
          const mode = showing ? 'showing' : 'hidden';
          if (target.mode !== mode) target.mode = mode;
        }
      }

      // Element to engine: a pick in the browser's caption menu. Fires for
      // the mirror's own writes too; those find the engine in step.
      function onNativeChange(): void {
        for (const [channel, native] of natives) {
          const track = captionTrack(channel);
          if (track === null) continue;
          const on = native.mode === 'showing';
          if (on && !selected(track)) {
            ctx.dispatch({ type: 'SELECT_TRACK', trackId: track.id });
            return;
          }
          if (!on && selected(track)) {
            ctx.dispatch({ type: 'DESELECT_TRACK', contentType: 'text' });
            return;
          }
        }
      }

      function show(channel: Channel, cues: readonly Cue[]): void {
        if (cues.length === 0) return;
        // Captions the manifest did not declare: the media reveals the track.
        if (captionTrack(channel) === null && !adding.has(channel)) {
          if (ctx.getState().presentation !== null) {
            adding.add(channel);
            ctx.dispatch({ type: 'ADD_TRACK', track: added(channel) });
          }
        }
        const VttCue = (globalThis as { VTTCue?: CueCtor }).VTTCue;
        if (VttCue === undefined) return;
        const target = ensureNative(channel);
        for (const cue of cues) {
          target.addCue(new VttCue(cue.start, cue.end, cue.text) as unknown as TextTrackCue);
        }
      }

      const unregister = registerCaptionConsumer((packets) => {
        for (const packet of packets) {
          for (const triple of packet.triples) {
            // Types 2 and 3 are CEA-708 packet data, which this does not read.
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

      const offChanged = ctx.on('tracks:changed', () => {
        // A new source has no added track until its own first cue.
        for (const channel of [...adding]) {
          if (captionTrack(channel) === null) adding.delete(channel);
        }
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
        for (const native of natives.values()) {
          emptyTextTrack(native);
          native.mode = 'disabled';
        }
        natives.clear();
      };
    },
  };
}
