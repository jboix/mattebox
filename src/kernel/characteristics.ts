/**
 * Questions a player asks to label a track, answered from the standard
 * signals only: the media characteristic tags, which the adapters map
 * every manifest's accessibility descriptors to, and the standard roles. A
 * tag outside these stays a plain string in `characteristics`, for the page
 * to filter on.
 */
import type { Track, VideoKind } from '../types/ir.js';

function has(track: Track, tag: string): boolean {
  return track.characteristics?.includes(tag) === true;
}

/** Audio that describes the picture. */
export function isAudioDescription(track: Track): boolean {
  return has(track, 'public.accessibility.describes-video');
}

/** Audio processed so speech is easier to follow. */
export function isEnhancedSpeech(track: Track): boolean {
  return has(track, 'public.accessibility.enhances-speech-intelligibility');
}

/**
 * Subtitles for the deaf and hard of hearing: tagged for both dialogue and
 * sounds, as Apple's authoring rules require, or carrying the role caption.
 */
export function isSdh(track: Track): boolean {
  return (
    (has(track, 'public.accessibility.transcribes-spoken-dialog') &&
      has(track, 'public.accessibility.describes-music-and-sound')) ||
    track.roles?.includes('caption') === true
  );
}

/** The language the content was made in, not a translation. */
export function isOriginal(track: Track): boolean {
  return has(track, 'public.original-content');
}

/**
 * The kind of a video track from its standard roles, as HTML's rules for
 * media containers map them to VideoTrack.kind: sign and commentary stand
 * alone, caption and subtitle with main are a picture with the text in it,
 * and alternate is another version.
 */
export function videoKind(track: Track): VideoKind {
  const roles = track.roles ?? (track.role !== undefined ? [track.role] : []);
  const main = roles.includes('main');
  if (roles.includes('sign')) return 'sign';
  if (roles.includes('commentary') && !main) return 'commentary';
  if (roles.includes('caption') && main) return 'captions';
  if (roles.includes('subtitle') && main) return 'subtitles';
  if (main) return 'main';
  if (roles.includes('alternate')) return 'alternative';
  return '';
}
