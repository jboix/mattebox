import { describe, expect, it } from 'vitest';
import { findRendition, findTrackSite } from '../../../src/kernel/presentation.js';
import type { Presentation } from '../../../src/types/ir.js';

const PRESENTATION: Presentation = {
  id: 'p',
  isLive: false,
  couplings: [],
  periods: [
    { id: 'a', start: 0, tracks: [] },
    {
      id: 'b',
      start: 10,
      tracks: [
        {
          id: 'video',
          contentType: 'video',
          mimeType: 'video/mp4',
          protection: null,
          renditions: [{ id: 'v1', bitrate: 1, codecs: null, mimeType: 'video/mp4', segments: [] }],
        },
      ],
    },
  ],
};

describe('presentation lookups', () => {
  it('find a track with its period', () => {
    const site = findTrackSite(PRESENTATION, 'video');
    expect(site?.period.id).toBe('b');
    expect(site?.track.id).toBe('video');
  });

  it('find a rendition with its track and period', () => {
    const site = findRendition(PRESENTATION, 'v1');
    expect(site?.rendition.id).toBe('v1');
    expect(site?.track.id).toBe('video');
    expect(site?.period.start).toBe(10);
  });

  it('answer null for an unknown id or no presentation', () => {
    expect(findTrackSite(PRESENTATION, 'audio')).toBeNull();
    expect(findRendition(PRESENTATION, 'v2')).toBeNull();
    expect(findTrackSite(null, 'video')).toBeNull();
    expect(findRendition(null, 'v1')).toBeNull();
  });
});
