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
import { syncNativeTracks } from './native-sync.js';
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

  const stopSync = syncNativeTracks(ctx, {
    tracks: () => declared().filter((track) => track.instreamId !== undefined),
    native: (track, create) => {
      const channel = track.instreamId as string;
      return natives.get(channel) ?? (create ? ensureNative(channel) : null);
    },
    idle: 'hidden',
    before() {
      // A new source has no added track until its own first cue.
      for (const channel of [...adding]) {
        if (captionTrack(channel) === null) adding.delete(channel);
      }
    },
  });

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
      stopSync();
      for (const native of natives.values()) {
        emptyTextTrack(native);
        native.mode = 'disabled';
      }
      natives.clear();
    },
  };
}
