import { describe, expect, it } from 'vitest';
import type { KernelState, Presentation, Track } from '../../../src/index.js';
import { videoKind } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { parse } from '../../../src/protocols/hls-cmaf/parse.js';
import { LOAD_FAILED, unavailableMessages } from '../../../src/protocols/hls-cmaf/unavailable.js';
import type { MatteboxError } from '../../../src/types/error.js';

const BASE = 'https://cdn.example/master.m3u8';

// RFC 8216 §8.7 shape: one VIDEO group per bandwidth, each listing the same
// versions of the picture, here the main camera and a sign-language version.
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",LANGUAGE="de",DEFAULT=YES,URI="a.m3u8"',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="low",NAME="Main",DEFAULT=YES,URI="low/main.m3u8"',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="low",NAME="Gebärdensprache",LANGUAGE="sgg",URI="low/sign.m3u8"',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="high",NAME="Main",DEFAULT=YES,URI="high/main.m3u8"',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="high",NAME="Gebärdensprache",LANGUAGE="sgg",URI="high/sign.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x360,VIDEO="low",AUDIO="aac"',
  'low/main.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720,VIDEO="high",AUDIO="aac"',
  'high/main.m3u8',
].join('\n');

function presentationOf(text: string): Presentation {
  const presentation = parse(text, BASE).presentation;
  if (presentation === null) throw new Error('the master did not parse');
  return presentation;
}

function videoTracks(presentation: Presentation): Track[] {
  return presentation.periods[0]?.tracks.filter((t) => t.contentType === 'video') ?? [];
}

function loaded(presentation: Presentation): KernelState {
  const reduce = createReducer();
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: BASE });
  [state] = reduce(state, { type: 'MANIFEST_LOADED', presentation });
  return state;
}

describe('HLS VIDEO renditions', () => {
  it('become one video track per version, each with one rendition per variant', () => {
    const [main, sign] = videoTracks(presentationOf(MASTER));
    expect(main).toMatchObject({ id: 'video-main', name: 'Main', role: 'main' });
    expect(main?.renditions.map((r) => [r.id, r.playlistUrl, r.height])).toEqual([
      ['v-800000', 'https://cdn.example/low/main.m3u8', 360],
      ['v-3000000', 'https://cdn.example/high/main.m3u8', 720],
    ]);
    expect(sign).toMatchObject({
      id: 'video:Gebärdensprache',
      name: 'Gebärdensprache',
      lang: 'sgg',
      role: 'alternate',
    });
    expect(sign?.renditions.map((r) => [r.id, r.playlistUrl, r.bitrate])).toEqual([
      ['v-800000:Gebärdensprache', 'https://cdn.example/low/sign.m3u8', 800000],
      ['v-3000000:Gebärdensprache', 'https://cdn.example/high/sign.m3u8', 3000000],
    ]);
  });

  it('couple every version to the audio group of its variant', () => {
    const { couplings } = presentationOf(MASTER);
    expect(couplings.map((c) => [c.renditionId, c.requires.audio])).toEqual([
      ['v-800000', 'aac'],
      ['v-800000:Gebärdensprache', 'aac'],
      ['v-3000000', 'aac'],
      ['v-3000000:Gebärdensprache', 'aac'],
    ]);
  });

  it('take a member without URI as the variant playlist, and as the main one without DEFAULT', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="v",NAME="Field"',
      '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="v",NAME="Dugout",URI="dugout.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f",VIDEO="v"',
      'field.m3u8',
    ].join('\n');
    const [main, dugout] = videoTracks(presentationOf(master));
    expect(main).toMatchObject({ name: 'Field', role: 'main' });
    expect(main?.renditions[0]?.playlistUrl).toBe('https://cdn.example/field.m3u8');
    expect(dugout?.renditions[0]?.playlistUrl).toBe('https://cdn.example/dugout.m3u8');
  });

  it('leave a variant without a VIDEO group as it was: one track, no name or role', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f"',
      'v.m3u8',
    ].join('\n');
    const [only, ...rest] = videoTracks(presentationOf(master));
    expect(rest).toEqual([]);
    expect(only?.name).toBeUndefined();
    expect(only?.role).toBeUndefined();
  });
});

describe('the kind of a video track', () => {
  const kind = (roles: string[]) =>
    videoKind({
      id: 't',
      contentType: 'video',
      mimeType: 'video/mp4',
      roles,
      protection: null,
      renditions: [],
    });

  it('follows HTML: DASH Role values to VideoTrack.kind', () => {
    expect(kind(['main'])).toBe('main');
    expect(kind(['alternate'])).toBe('alternative');
    expect(kind(['sign'])).toBe('sign');
    expect(kind(['main', 'caption'])).toBe('captions');
    expect(kind(['main', 'subtitle'])).toBe('subtitles');
    expect(kind(['commentary'])).toBe('commentary');
    expect(kind([])).toBe('');
  });

  it('reads the one role an HLS track carries', () => {
    const [main, sign] = videoTracks(presentationOf(MASTER));
    expect(main && videoKind(main)).toBe('main');
    expect(sign && videoKind(sign)).toBe('alternative');
  });
});

describe('the kernel with several versions of the picture', () => {
  it('starts on the main picture, even when a sign-language version is listed first', () => {
    const presentation = presentationOf(MASTER);
    const period = presentation.periods[0];
    if (period === undefined) throw new Error('no period');
    const tracks = [...period.tracks];
    const signFirst: Presentation = {
      ...presentation,
      periods: [
        {
          ...period,
          tracks: [
            { ...(tracks[1] as Track), roles: ['sign'] },
            ...tracks.filter((_, i) => i !== 1),
          ],
        },
      ],
    };
    expect(signFirst.periods[0]?.tracks[0]?.id).toBe('video:Gebärdensprache');
    expect(loaded(signFirst).tracks.active.get('video')).toBe('video-main');
  });

  it('switches to another version on SELECT_TRACK', () => {
    const reduce = createReducer();
    let state = loaded(presentationOf(MASTER));
    const [next] = reduce(state, { type: 'SELECT_TRACK', trackId: 'video:Gebärdensprache' });
    state = next;
    expect(state.tracks.active.get('video')).toBe('video:Gebärdensprache');
  });

  it('plays on when only another version than the one playing is gone', () => {
    const state = loaded(presentationOf(MASTER));
    const error: MatteboxError = {
      category: 'network',
      code: 'NETWORK_HTTP_STATUS',
      fatal: false,
      recoverable: true,
      context: {},
    };
    const messages = unavailableMessages(
      state,
      LOAD_FAILED,
      ['v-800000:Gebärdensprache', 'v-3000000:Gebärdensprache'],
      error,
    );
    expect(messages.map((m) => m.type)).toEqual(['CONSTRAIN']);
    const fatal = unavailableMessages(state, LOAD_FAILED, ['v-800000', 'v-3000000'], error);
    expect(fatal.map((m) => m.type)).toEqual(['MANIFEST_FAILED']);
  });
});
