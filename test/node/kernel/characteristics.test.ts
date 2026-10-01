import { describe, expect, it } from 'vitest';
import {
  isAudioDescription,
  isEnhancedSpeech,
  isOriginal,
  isSdh,
} from '../../../src/kernel/characteristics.js';
import type { Track } from '../../../src/types/ir.js';

function track(extra: Partial<Track>): Track {
  return {
    id: 't',
    contentType: 'audio',
    mimeType: 'audio/mp4',
    protection: null,
    renditions: [],
    ...extra,
  };
}

describe('track characteristics', () => {
  it('reads audio description and enhanced speech from the standard tags', () => {
    const ad = track({ characteristics: ['public.accessibility.describes-video'] });
    const clean = track({
      characteristics: ['public.accessibility.enhances-speech-intelligibility'],
    });
    expect([isAudioDescription(ad), isEnhancedSpeech(ad)]).toEqual([true, false]);
    expect([isAudioDescription(clean), isEnhancedSpeech(clean)]).toEqual([false, true]);
    expect(isAudioDescription(track({}))).toBe(false);
  });

  it('reads SDH from both Apple tags or the DASH caption role, not from one tag alone', () => {
    const both = [
      'public.accessibility.transcribes-spoken-dialog',
      'public.accessibility.describes-music-and-sound',
    ];
    expect(isSdh(track({ contentType: 'text', characteristics: both }))).toBe(true);
    expect(isSdh(track({ contentType: 'text', roles: ['caption'] }))).toBe(true);
    expect(
      isSdh(track({ characteristics: ['public.accessibility.transcribes-spoken-dialog'] })),
    ).toBe(false);
    // A tag outside the standard ones is no signal: it stays a string to filter on.
    expect(
      isSdh(track({ characteristics: ['public.accessibility.describes-spoken-dialog'] })),
    ).toBe(false);
  });

  it('reads original content', () => {
    expect(isOriginal(track({ characteristics: ['public.original-content'] }))).toBe(true);
    expect(isOriginal(track({ roles: ['main'] }))).toBe(false);
  });
});
