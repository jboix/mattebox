import { describe, expect, it } from 'vitest';
import type { Effect, KernelState, Presentation } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { parse } from '../../../src/protocols/hls-cmaf/parse.js';
import type { AbrChooser } from '../../../src/types/quality.js';
import { vodFixture } from './helpers.js';

/** A browser like Chrome on Linux: H.264 and AAC, no HEVC, Dolby Vision, AC-3, or E-AC-3. */
const chrome = (type: string) => !/hvc1|hev1|dvh1|dvhe|ac-3|ec-3/.test(type);

/** Always takes the highest bitrate it is offered, the way ABR does on a fast link. */
const greedy: AbrChooser = {
  choose: (allowed) => [...allowed].sort((a, b) => b.bitrate - a.bitrate)[0]?.id ?? '',
};

// The shape of the Apple TV preview that failed: HEVC, Dolby Vision, and
// H.264 variants, each paired with an AAC, AC-3, or E-AC-3 audio group.
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="aac.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",NAME="English",DEFAULT=YES,URI="ac3.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="atmos",NAME="English",DEFAULT=YES,URI="atmos.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.64001f,mp4a.40.29",AUDIO="aac"',
  'avc-low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=700000,CODECS="ac-3,avc1.64001f",AUDIO="ac3"',
  'avc-low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.64001f,ec-3",AUDIO="atmos"',
  'avc-low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"',
  'avc-high.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="hvc1.2.20000000.L123.B0,mp4a.40.2",AUDIO="aac"',
  'hevc.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="dvh1.05.06,ec-3",AUDIO="atmos"',
  'dv.m3u8',
].join('\n');

function presentationOf(text: string): Presentation {
  const presentation = parse(text, 'https://cdn.example/master.m3u8').presentation;
  if (presentation === null) throw new Error('the master did not parse');
  return presentation;
}

function load(
  reduce: ReturnType<typeof createReducer>,
  presentation: Presentation,
): readonly [KernelState, readonly Effect[]] {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
  return reduce(state, { type: 'MANIFEST_LOADED', presentation });
}

describe('renditions the browser cannot decode', () => {
  it('are excluded when the manifest loads, with the variants that need an undecodable group', () => {
    const reduce = createReducer([], undefined, { decodable: chrome });
    const [state] = load(reduce, presentationOf(MASTER));
    const excluded = [...(state.quality.constraints.get('codecs')?.excludeIds ?? [])].sort();
    expect(excluded).toEqual(
      [
        'ac3:English',
        'atmos:English',
        'v-700000', // H.264, but its audio group is AC-3
        'v-800000', // H.264, but its audio group is E-AC-3
        'v-5000000', // HEVC
        'v-8000000', // Dolby Vision
      ].sort(),
    );
  });

  it('ABR never reaches one, however fast the link', () => {
    const reduce = createReducer([], undefined, { decodable: chrome, abr: greedy });
    const [state] = load(reduce, presentationOf(MASTER));
    expect(state.quality.active).toBe('v-3000000');
  });

  it('the first decodable audio track is the default, not the first listed', () => {
    const presentation: Presentation = {
      ...vodFixture,
      periods: vodFixture.periods.map((period) => ({
        ...period,
        tracks: [
          ...period.tracks.filter((t) => t.contentType === 'video'),
          {
            id: 'a-ec3',
            contentType: 'audio',
            mimeType: 'audio/mp4',
            protection: null,
            renditions: [
              {
                id: 'ec3-1',
                bitrate: 384_000,
                codecs: 'ec-3',
                mimeType: 'audio/mp4',
                segments: [{ seq: 0, start: 0, duration: 4, url: 'https://cdn.example/ec3/0.m4s' }],
              },
            ],
          },
          ...period.tracks.filter((t) => t.contentType === 'audio'),
        ],
      })),
    };
    const reduce = createReducer([], undefined, { decodable: chrome });
    const [state] = load(reduce, presentation);
    expect(state.tracks.active.get('audio')).toBe('a');
  });

  it('selecting a track the browser cannot decode is rejected', () => {
    const reduce = createReducer([], undefined, { decodable: chrome });
    const [state] = load(reduce, presentationOf(MASTER));
    const [next, fx] = reduce(state, { type: 'SELECT_TRACK', trackId: 'atmos:English' });
    expect(next.tracks.active.get('audio')).toBe('aac:English');
    expect(fx).toEqual([
      {
        kind: 'emit',
        event: 'command:rejected',
        payload: { command: 'SELECT_TRACK', reason: 'undecodable track: atmos:English' },
      },
    ]);
  });

  it('when nothing is decodable the load fails at once with the codecs it named', () => {
    const reduce = createReducer([], undefined, { decodable: () => false });
    const [state, fx] = load(reduce, presentationOf(MASTER));
    expect(state.lifecycle.phase).toBe('error');
    expect(fx).toContainEqual(
      expect.objectContaining({
        kind: 'emit',
        event: 'error',
        payload: expect.objectContaining({ code: 'MEDIA_CODEC_UNSUPPORTED', fatal: true }),
      }),
    );
    expect(fx.filter((e) => e.kind === 'createSourceBuffer' || e.kind === 'fetch')).toEqual([]);
  });

  it('without the check every declared codec counts as decodable', () => {
    const reduce = createReducer();
    const [state] = load(reduce, presentationOf(MASTER));
    expect(state.quality.constraints.has('codecs')).toBe(false);
  });
});

describe('an audio track switch across codec families', () => {
  it('changes the buffer type before the new init, as a video codec change does', () => {
    const presentation: Presentation = {
      ...vodFixture,
      periods: vodFixture.periods.map((period) => ({
        ...period,
        tracks: [
          ...period.tracks.map((track) =>
            track.id !== 'a'
              ? track
              : {
                  ...track,
                  renditions: track.renditions.map((r) => ({
                    ...r,
                    init: { url: 'https://cdn.example/a1/init.mp4' },
                  })),
                },
          ),
          {
            id: 'a-ec3',
            contentType: 'audio',
            mimeType: 'audio/mp4',
            protection: null,
            renditions: [
              {
                id: 'ec3-1',
                bitrate: 384_000,
                codecs: 'ec-3',
                mimeType: 'audio/mp4',
                init: { url: 'https://cdn.example/ec3/init.mp4' },
                segments: [{ seq: 0, start: 0, duration: 4, url: 'https://cdn.example/ec3/0.m4s' }],
              },
            ],
          },
        ],
      })),
    };
    const reduce = createReducer();
    let [state] = load(reduce, presentation);
    [state] = reduce(state, {
      type: 'SOURCEBUFFER_CREATED',
      sbId: 'sb:audio',
      codecs: 'audio/mp4; codecs="mp4a.40.2"',
    });
    const initOf = (trackId: string) =>
      [...state.scheduling.inflight.values()].find((r) => r.trackId === trackId && r.seq < 0);
    const answer = (trackId: string): readonly Effect[] => {
      const request = initOf(trackId);
      if (request === undefined) throw new Error(`no init request for ${trackId}`);
      const [next, fx] = reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId,
        seq: request.seq,
        token: request.token,
        bytes: new ArrayBuffer(8),
        rtt: 0,
        size: 8,
      });
      state = next;
      return fx;
    };
    answer('a');
    [state] = reduce(state, { type: 'SELECT_TRACK', trackId: 'a-ec3' });
    [state] = reduce(state, { type: 'SOURCEBUFFER_UPDATEEND', sbId: 'sb:audio', ranges: [] });
    const fx = answer('a-ec3');
    const changeType = fx.findIndex((e) => e.kind === 'changeType');
    expect(fx[changeType]).toEqual({
      kind: 'changeType',
      sbId: 'sb:audio',
      codecs: 'audio/mp4; codecs="ec-3"',
    });
    expect(changeType).toBeLessThan(fx.findIndex((e) => e.kind === 'append'));
  });
});
