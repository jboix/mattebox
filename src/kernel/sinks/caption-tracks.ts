/**
 * The tracks of an in-band caption format, shared by text-cea608 and
 * text-cea708 so neither imports the other. Each channel (CC1 to CC4, or
 * SERVICE1 to SERVICE63) is a text track like any subtitle: the manifest
 * declares it, or the first cue adds it (ADD_TRACK). Its cues go to one
 * native caption TextTrack labelled with the channel, which shows while the
 * channel's track is selected and stays hidden otherwise, so cues keep
 * arriving. A pick in the browser's caption menu selects the track in the
 * engine, and the reverse.
 */
import type { Track } from '../../types/ir.js';
import type { StageContext } from '../../types/stage.js';
import { adoptTextTrack, emptyTextTrack } from './text-track-sink.js';

// A minimal VTTCue view; the DOM lib's shape without pulling it in here.
type CueCtor = new (start: number, end: number, text: string) => TextTrackCue;

export interface InbandCaptions {
  /** Adds cues to the channel's native track, adding the channel's track first if it is new. */
  show(channel: string, cues: readonly TextTrackCue[]): void;
  dispose(): void;
}

/** A VTTCue, or null where the browser has none. */
export function vttCue(start: number, end: number, text: string): TextTrackCue | null {
  const Ctor = (globalThis as { VTTCue?: CueCtor }).VTTCue;
  return Ctor === undefined ? null : new Ctor(start, end, text);
}

/** Wires a caption format's channels to tracks. `prefix` names added tracks, as `cea608:CC1`. */
export function inbandCaptions(ctx: StageContext, mime: string, prefix: string): InbandCaptions {
  const element = ctx.element;
  const natives = new Map<string, TextTrack>();
  const adding = new Set<string>();

  function declared(): Track[] {
    const out: Track[] = [];
    for (const period of ctx.getState().presentation?.periods ?? []) {
      for (const track of period.tracks) if (track.mimeType === mime) out.push(track);
    }
    return out;
  }

  /** The channel's caption track in the presentation, declared or added. */
  function captionTrack(channel: string): Track | null {
    return declared().find((track) => track.instreamId === channel) ?? null;
  }

  function selected(track: Track | null): boolean {
    return track !== null && ctx.getState().tracks.active.get('text') === track.id;
  }

  /** The channel's native track, created on first need. Hidden keeps cues arriving and removable. */
  function ensureNative(channel: string): TextTrack {
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
    const channels = new Set(natives.keys());
    for (const track of declared())
      if (track.instreamId !== undefined) channels.add(track.instreamId);
    for (const channel of channels) {
      const showing = selected(captionTrack(channel));
      if (!natives.has(channel) && !showing) continue;
      const target = ensureNative(channel);
      const mode = showing ? 'showing' : 'hidden';
      if (target.mode !== mode) target.mode = mode;
    }
  }

  // Element to engine: a pick in the browser's caption menu. Fires for the
  // mirror's own writes too; those find the engine in step.
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

  return {
    show(channel, cues) {
      if (cues.length === 0) return;
      // Captions the manifest did not declare: the media reveals the track.
      if (captionTrack(channel) === null && !adding.has(channel)) {
        if (ctx.getState().presentation !== null) {
          adding.add(channel);
          ctx.dispatch({
            type: 'ADD_TRACK',
            track: {
              id: `${prefix}:${channel}`,
              contentType: 'text',
              mimeType: mime,
              protection: null,
              role: 'caption',
              instreamId: channel,
              renditions: [],
            },
          });
        }
      }
      const target = ensureNative(channel);
      for (const cue of cues) target.addCue(cue);
    },
    dispose() {
      offChanged();
      offSelected();
      element.textTracks.removeEventListener('change', onNativeChange);
      for (const native of natives.values()) {
        emptyTextTrack(native);
        native.mode = 'disabled';
      }
      natives.clear();
    },
  };
}
