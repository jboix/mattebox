/**
 * Forced subtitles: text the content needs where the audio does not carry
 * it, such as translated signs. The selection follows Apple's rule for
 * forced-only legible options (AV Foundation release notes, "forced
 * subtitles"): while no regular subtitle is chosen, the forced track that
 * goes with the audio language shows, else the first forced track.
 *
 * "No regular subtitle" includes the user turning subtitles off: off means
 * no subtitle choice, so the forced track still shows. A regular subtitle
 * the user picks replaces it; that track already holds the forced cues
 * (Apple HLS authoring spec 5.8). Turning the stage off removes a forced
 * track it shows.
 *
 * The rule works on any text track marked forced, whatever its format, and
 * picks only a format a stage in the composition plays. It is policy, so it
 * stays out of the kernel: it watches track events and dispatches the same
 * SELECT_TRACK and DESELECT_TRACK commands a viewer would.
 */
import type { Track } from '../../types/ir.js';
import type { KernelState } from '../../types/kernel.js';
import type { Capability, Stage } from '../../types/stage.js';

export interface ForcedSubtitlesOptions {
  /** Whether forced subtitles show. Defaults to true. */
  readonly enabled?: boolean;
}

export interface ForcedSubtitlesApi {
  /** Whether forced subtitles show. Setting it applies at once. */
  enabled: boolean;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    forcedSubtitles: ForcedSubtitlesApi;
  }
}

function textTracks(state: Readonly<KernelState>): readonly Track[] {
  return (state.presentation?.periods ?? []).flatMap((period) =>
    period.tracks.filter((track) => track.contentType === 'text'),
  );
}

/** The primary language subtag, lowercase: 'en' for 'en-US'. */
function primary(lang: string): string {
  return (lang.split('-')[0] as string).toLowerCase();
}

/**
 * The forced track to show: the one whose language matches the audio,
 * exactly before by primary subtag, else the first. Null without candidates.
 */
export function pickForced(candidates: readonly Track[], audioLang: string | null): Track | null {
  if (audioLang !== null) {
    const exact = candidates.find((t) => t.lang?.toLowerCase() === audioLang.toLowerCase());
    if (exact !== undefined) return exact;
    const near = candidates.find(
      (t) => t.lang !== undefined && primary(t.lang) === primary(audioLang),
    );
    if (near !== undefined) return near;
  }
  return candidates[0] ?? null;
}

function plays(capabilities: readonly Capability[], track: Track): boolean {
  return capabilities.some(
    (c) => typeof c !== 'string' && c.contentType === 'text' && c.mimeType === track.mimeType,
  );
}

export default function forcedSubtitles(options: ForcedSubtitlesOptions = {}): Stage {
  return {
    name: 'forced-subtitles',
    provides: ['forced-subtitles'],
    requires: ['scheduler'],
    install(ctx) {
      let enabled = options.enabled ?? true;

      // Runs on every track event, its own selections included; those find
      // the selection already in place and dispatch nothing.
      function reconcile(): void {
        const state = ctx.getState();
        if (state.presentation === null) return;
        const tracks = textTracks(state);
        const activeId = state.tracks.active.get('text');
        const active = tracks.find((t) => t.id === activeId) ?? null;
        // A regular subtitle is the viewer's choice; it stays.
        if (active !== null && active.forced !== true) return;
        if (!enabled) {
          if (active !== null) ctx.dispatch({ type: 'DESELECT_TRACK', contentType: 'text' });
          return;
        }
        const capabilities = ctx.capabilities();
        const candidates = tracks.filter((t) => t.forced === true && plays(capabilities, t));
        const audioId = state.tracks.active.get('audio');
        const audio = state.presentation.periods
          .flatMap((period) => period.tracks)
          .find((t) => t.id === audioId);
        const target = pickForced(candidates, audio?.lang ?? null);
        if (target !== null && target.id !== activeId) {
          ctx.dispatch({ type: 'SELECT_TRACK', trackId: target.id });
        }
      }

      const api: ForcedSubtitlesApi = {
        get enabled() {
          return enabled;
        },
        set enabled(value) {
          enabled = value;
          reconcile();
        },
      };
      ctx.registerNamespace('forcedSubtitles', api);
      const offChanged = ctx.on('tracks:changed', reconcile);
      const offSelected = ctx.on('tracks:selected', reconcile);
      return () => {
        offChanged();
        offSelected();
      };
    },
  };
}
