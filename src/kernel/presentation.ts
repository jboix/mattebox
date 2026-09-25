/**
 * Lookups over a presentation by id. Pure. The kernel, the protocol
 * adapters, and the stages all walk periods, tracks, and renditions the
 * same way; this is the one copy.
 */
import type { Period, Presentation, Rendition, Track } from '../types/ir.js';

/** A track and the period that holds it. */
export interface TrackSite {
  readonly track: Track;
  readonly period: Period;
}

/** A rendition with the track and period that hold it. */
export interface RenditionSite extends TrackSite {
  readonly rendition: Rendition;
}

export function findTrackSite(
  presentation: Presentation | null,
  trackId: string,
): TrackSite | null {
  for (const period of presentation?.periods ?? []) {
    for (const track of period.tracks) {
      if (track.id === trackId) return { track, period };
    }
  }
  return null;
}

export function findRendition(
  presentation: Presentation | null,
  renditionId: string,
): RenditionSite | null {
  for (const period of presentation?.periods ?? []) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) return { rendition, track, period };
      }
    }
  }
  return null;
}
