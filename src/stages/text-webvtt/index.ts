/**
 * WebVTT as a stage: a parser for text/vtt and the text sink registration
 * that makes text tracks selectable. Cues become native VTTCues through the
 * kernel's TextTrackSink; the browser renders, styles, and exposes the
 * caption UI, which is why this stage stays small.
 *
 * The stage also keeps the element's TextTrackList and the engine's text
 * selection in step, both ways. Every text track exists natively from the
 * manifest on, so the browser's caption menu lists all of them; the active
 * one is `showing`, the rest `disabled`. A pick in that menu selects in the
 * engine, and switching captions off there deselects.
 */
import { createTextTrackSink } from '../../kernel/sinks/text-track-sink.js';
import type { Track } from '../../types/ir.js';
import type { CueDescriptor } from '../../types/messages.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';
import { parseVtt } from './parse.js';

function parseSegment(data: Uint8Array, _meta: SegmentMeta): readonly CueDescriptor[] {
  return parseVtt(new TextDecoder().decode(data)).cues;
}

export default function textWebvtt(): Stage {
  return {
    name: 'text-webvtt',
    provides: ['text-webvtt', { contentType: 'text', mimeType: 'text/vtt' }],
    requires: ['scheduler'],
    install(ctx) {
      const { element } = ctx;
      // One sink per attach, built here rather than in the factory so the
      // mirror below can declare tracks before any segment is fetched.
      const sink = createTextTrackSink({ element, parse: parseSegment });
      ctx.registerParser('text/vtt', parseSegment);
      ctx.registerSink('text', () => sink);

      function textTracks(): readonly Track[] {
        const presentation = ctx.getState().presentation;
        if (presentation === null) return [];
        return presentation.periods.flatMap((period) =>
          period.tracks.filter((track) => track.contentType === 'text'),
        );
      }
      function activeId(): string | undefined {
        return ctx.getState().tracks.active.get('text');
      }

      // Engine to element. A track no longer in the presentation (a new
      // source on the same engine) is retired first, so its last cue does
      // not outlive it on screen.
      function mirror(): void {
        const active = activeId();
        const current = new Set(textTracks().map((track) => track.id));
        for (const id of sink.trackIds()) {
          if (!current.has(id)) sink.retire(id);
        }
        for (const track of textTracks()) {
          const native = sink.declare(track.id);
          const mode = track.id === active ? 'showing' : 'disabled';
          if (native.mode !== mode) native.mode = mode;
        }
      }
      // Element to engine. Fires for the mirror's own writes too; those
      // find the element already in step and dispatch nothing.
      function onNativeChange(): void {
        const active = activeId();
        const showing = textTracks().find(
          (track) => sink.nativeTrack(track.id)?.mode === 'showing',
        );
        if (showing !== undefined) {
          if (showing.id !== active) ctx.dispatch({ type: 'SELECT_TRACK', trackId: showing.id });
        } else if (active !== undefined) {
          ctx.dispatch({ type: 'DESELECT_TRACK', contentType: 'text' });
        }
      }

      ctx.on('tracks:changed', mirror);
      ctx.on('tracks:selected', (payload) => {
        if ((payload as { contentType?: string }).contentType === 'text') mirror();
      });
      element.textTracks.addEventListener('change', onNativeChange);
      return () => {
        element.textTracks.removeEventListener('change', onNativeChange);
        sink.dispose();
      };
    },
  };
}
