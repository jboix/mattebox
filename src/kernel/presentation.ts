/**
 * Lookups over a presentation by id. Pure. The kernel, the protocol
 * adapters, and the stages all walk periods, tracks, and renditions the
 * same way; this is the one copy.
 */
import type { Period, Presentation, Rendition, Track } from '../types/ir.js';
import { videoKind } from './characteristics.js';

/** A track and the period that holds it. */
export interface TrackSite {
  readonly track: Track;
  readonly period: Period;
}

/** A rendition with the track and period that hold it. */
export interface RenditionSite extends TrackSite {
  readonly rendition: Rendition;
}

/** An I-frame-only video track, kept for trick play and never selected for normal playback. */
export function isTrick(track: Track): boolean {
  return track.role === 'trick';
}

/**
 * A video track that shows the main picture: its kind is main, or the
 * manifest gives none. Not a sign-language, alternate or commentary version.
 */
export function isMainPicture(track: Track): boolean {
  const kind = videoKind(track);
  return !isTrick(track) && (kind === 'main' || kind === '');
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
