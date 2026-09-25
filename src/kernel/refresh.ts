/**
 * Merges one rendition's segment list into a presentation. Pure. The
 * kernel applies a PLAYLIST_REFRESHED here against the presentation it
 * holds when the fact lands, so two renditions resolved in the same turn
 * both keep their segments.
 */
import type { Presentation } from '../types/ir.js';
import type { Fact } from '../types/messages.js';

export type PlaylistRefresh = Extract<Fact, { readonly type: 'PLAYLIST_REFRESHED' }>;

/** The presentation with the refresh merged, or null when it names no rendition the presentation holds. */
export function applyRefresh(
  presentation: Presentation,
  refresh: PlaylistRefresh,
): Presentation | null {
  const renditionId = refresh.renditionId;
  if (renditionId === undefined) return null;
  let found = false;
  const periods = presentation.periods.map((period) => ({
    ...period,
    tracks: period.tracks.map((track) => {
      if (!track.renditions.some((r) => r.id === renditionId)) return track;
      found = true;
      return {
        ...track,
        protection: track.protection ?? refresh.protection ?? null,
        renditions: track.renditions.map((rendition) =>
          rendition.id === renditionId
            ? {
                ...rendition,
                segments: refresh.segments,
                ...(refresh.init !== undefined ? { init: refresh.init } : {}),
                ...(refresh.tiles !== undefined ? { tiles: refresh.tiles } : {}),
              }
            : rendition,
        ),
      };
    }),
  }));
  if (!found) return null;
  if (refresh.endlist === undefined) return { ...presentation, periods };
  if (refresh.endlist) {
    const duration = refresh.segments.reduce((sum, s) => sum + s.duration, 0);
    return {
      ...presentation,
      isLive: false,
      duration: Math.max(presentation.duration ?? 0, duration),
      periods,
    };
  }
  return {
    ...presentation,
    isLive: true,
    live: {
      ...presentation.live,
      ...(refresh.updatePeriod !== undefined ? { updatePeriod: refresh.updatePeriod } : {}),
      ...(refresh.dateAnchor !== undefined ? { dateAnchor: refresh.dateAnchor } : {}),
    },
    periods,
  };
}
