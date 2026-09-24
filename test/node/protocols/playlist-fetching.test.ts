// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import dashCmaf from '../../../src/protocols/dash-cmaf/index.js';
import dashLive from '../../../src/protocols/dash-live/index.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import { parseMediaPlaylist, refreshFor } from '../../../src/protocols/hls-cmaf/parse.js';
import hlsLive from '../../../src/protocols/hls-live/index.js';
import type { Presentation, Segment } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { Stage } from '../../../src/types/stage.js';

type Reduce = ReturnType<typeof createReducer>;

function compose(...factories: Array<() => Stage>): Reduce {
  const slices: Array<readonly [string, SliceReducer]> = [];
  for (const factory of factories) {
    factory().install({
      element: {} as HTMLMediaElement,
      registerSink: () => undefined,
      registerParser: () => undefined,
      registerTransform: () => undefined,
      registerNamespace: () => undefined,
      registerChooser: () => undefined,
      registerSwitchPolicy: () => undefined,
      registerTypeProbe: () => undefined,
      registerTimeProbe: () => undefined,
      getState: () => initialState(),
      addRequestHook: () => () => undefined,
      request: async () => new Response(),
      reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
      dispatch: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
    });
  }
  return createReducer(slices);
}

/** Follows zero-delay loop-back schedule effects the way the runner would. */
function settle(
  reduce: Reduce,
  state: KernelState,
  effects: readonly Effect[],
): { state: KernelState; effects: Effect[] } {
  let current = state;
  const all: Effect[] = [...effects];
  let frontier = effects;
  while (frontier.length > 0) {
    const next: Effect[] = [];
    for (const effect of frontier) {
      if (effect.kind !== 'schedule' || effect.delayMs !== 0) continue;
      const [reduced, produced] = reduce(current, effect.then);
      current = reduced;
      next.push(...produced);
    }
    all.push(...next);
    frontier = next;
  }
  return { state: current, effects: all };
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

type Fetch = Extract<Effect, { kind: 'fetch' }>;

function fetches(effects: readonly Effect[], prefix: string): Fetch[] {
  return effects.filter((e): e is Fetch => e.kind === 'fetch' && e.token.startsWith(prefix));
}

/** A response for `trackId`, correlated by `token` (the track id itself for a stage's fetch). */
function loaded(trackId: string, body: ArrayBuffer, token = trackId): Message {
  return { type: 'SEGMENT_LOADED', trackId, seq: 0, token, bytes: body, rtt: 5, size: 500 };
}

function failed(token: string): Message {
  return {
    type: 'SEGMENT_FAILED',
    trackId: token,
    seq: 0,
    status: 403,
    error: { category: 'network', code: 'NETWORK_HTTP_STATUS', fatal: false, recoverable: true },
  };
}

function vodPlaylist(prefix: string, count = 3): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < count; i += 1) lines.push('#EXTINF:4.000,', `${prefix}-${i}.m4s`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function segmentsOf(state: KernelState, renditionId: string): readonly Segment[] {
  for (const period of state.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId && Array.isArray(rendition.segments)) {
          return rendition.segments as readonly Segment[];
        }
      }
    }
  }
  return [];
}

const BASE = 'https://cdn.example/';

// Five distinct video playlists. The 1.5 Mbps variant differs from the
// 1 Mbps one only in its audio group, so both read v1.m3u8.
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",NAME="English",DEFAULT=YES,URI="audio-ac3.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"',
  'v1.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1500000,CODECS="avc1.4d401f,ac-3",AUDIO="ac3"',
  'v1.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"',
  'v2.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"',
  'v3.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"',
  'v4.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"',
  'v5.m3u8',
].join('\n');

describe('hls-cmaf fetches the media playlists the selection needs', () => {
  const reduce = compose(hlsCmaf);

  function boot(): { state: KernelState; effects: Effect[] } {
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: `${BASE}master.m3u8` });
    const token = [...state.scheduling.inflight.keys()][0] as string;
    return settle(reduce, ...reduce(state, loaded('manifest', bytes(MASTER), token)));
  }

  /** Answers every playlist fetch among `effects`, all before any merge lands. */
  function answerAll(state: KernelState, effects: readonly Effect[]) {
    let current = state;
    const produced: Effect[] = [];
    for (const fetch of fetches(effects, 'hls:pl:')) {
      const name = fetch.url.slice(BASE.length).replace('.m3u8', '');
      const [next, fx] = reduce(current, loaded(fetch.token, bytes(vodPlaylist(name))));
      current = next;
      produced.push(...fx);
    }
    return settle(reduce, current, produced);
  }

  it('at startup it fetches the playing rendition, the rung above, and the audio playlist', () => {
    const { effects } = boot();
    expect(fetches(effects, 'hls:pl:').map((f) => f.url)).toEqual([
      `${BASE}v1.m3u8`,
      `${BASE}v2.m3u8`,
      `${BASE}audio.m3u8`,
    ]);
  });

  it('one fetch serves every variant that reads the same playlist', () => {
    const booted = boot();
    const { state } = answerAll(booted.state, booted.effects);
    expect(segmentsOf(state, 'v-1000000')).toHaveLength(3);
    expect(segmentsOf(state, 'v-1500000')).toHaveLength(3);
  });

  it('answers that land before their merges never fetch a playlist twice', () => {
    const booted = boot();
    const answered = answerAll(booted.state, booted.effects);
    const [, timeFx] = reduce(answered.state, {
      type: 'TIME_UPDATE',
      currentTime: 1,
      buffered: [],
    });
    const all = [...booted.effects, ...answered.effects, ...timeFx];
    const urls = fetches(all, 'hls:pl:').map((f) => f.url);
    expect(urls).toHaveLength(new Set(urls).size);
    expect(urls).toHaveLength(3);
  });

  it('a pin far up the ladder fetches that playlist and its neighbours', () => {
    const booted = boot();
    const { state } = answerAll(booted.state, booted.effects);
    const [, fx] = reduce(state, {
      type: 'PIN_RENDITION',
      renditionId: 'v-4000000',
      apply: 'now',
    });
    expect(fetches(fx, 'hls:pl:').map((f) => f.url)).toEqual([
      `${BASE}v3.m3u8`,
      `${BASE}v4.m3u8`,
      `${BASE}v5.m3u8`,
    ]);
  });

  it('a playlist that fails is excluded and not fetched again; the next rung takes its place', () => {
    const booted = boot();
    const v2 = fetches(booted.effects, 'hls:pl:').find((f) => f.url.endsWith('v2.m3u8'));
    if (v2 === undefined) throw new Error('v2 was not fetched');
    const settled = settle(reduce, ...reduce(booted.state, failed(v2.token)));
    expect(settled.effects).toContainEqual(
      expect.objectContaining({
        kind: 'schedule',
        // biome-ignore lint/suspicious/noThenProperty: the schedule effect's field name
        then: {
          type: 'CONSTRAIN',
          source: 'hls:unavailable',
          constraint: { excludeIds: ['v-2000000'] },
        },
      }),
    );
    expect(fetches(settled.effects, 'hls:pl:').map((f) => f.url)).toEqual([`${BASE}v3.m3u8`]);
    expect(settled.state.lifecycle.phase).toBe('ready');
  });

  it('when the playing rendition fails, the next playlist loads without waiting for time to move', () => {
    // A paused element sends no TIME_UPDATE, so nothing re-arbitrates
    // until a playlist lands. The fetch has to come from the failure.
    const booted = boot();
    const v1 = fetches(booted.effects, 'hls:pl:').find((f) => f.url.endsWith('v1.m3u8'));
    if (v1 === undefined) throw new Error('v1 was not fetched');
    const settled = settle(reduce, ...reduce(booted.state, failed(v1.token)));
    // v2 is already on its way; v3 is the rung above it.
    expect(fetches(settled.effects, 'hls:pl:').map((f) => f.url)).toEqual([`${BASE}v3.m3u8`]);
    expect(settled.state.lifecycle.phase).toBe('ready');
  });

  it('a complete playlist with no segment counts as failed', () => {
    const booted = boot();
    const v2 = fetches(booted.effects, 'hls:pl:').find((f) => f.url.endsWith('v2.m3u8'));
    if (v2 === undefined) throw new Error('v2 was not fetched');
    const empty = bytes('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-ENDLIST');
    const settled = settle(reduce, ...reduce(booted.state, loaded(v2.token, empty)));
    expect(settled.effects).toContainEqual(
      expect.objectContaining({
        kind: 'emit',
        event: 'error',
        payload: expect.objectContaining({ code: 'MANIFEST_EMPTY', fatal: false }),
      }),
    );
    expect(fetches(settled.effects, 'hls:pl:').map((f) => f.url)).toEqual([`${BASE}v3.m3u8`]);
  });

  it('an audio group that fails excludes the variants that need it, and playback goes on', () => {
    const booted = boot();
    const audio = fetches(booted.effects, 'hls:pl:').find((f) => f.url.endsWith('audio.m3u8'));
    if (audio === undefined) throw new Error('audio was not fetched');
    const settled = settle(reduce, ...reduce(booted.state, failed(audio.token)));
    expect(settled.state.lifecycle.phase).toBe('ready');
    const excluded = settled.state.quality.constraints.get('hls:unavailable')?.excludeIds ?? [];
    // Every variant on the aac group goes; the ac-3 variant is left to play.
    expect([...excluded].sort()).toEqual(
      ['aac:English', 'v-1000000', 'v-2000000', 'v-3000000', 'v-4000000', 'v-5000000'].sort(),
    );
  });

  it('when no audio group is left the load fails, and nothing is fetched after', () => {
    const booted = boot();
    const audio = fetches(booted.effects, 'hls:pl:').find((f) => f.url.endsWith('audio.m3u8'));
    if (audio === undefined) throw new Error('audio was not fetched');
    let settled = settle(reduce, ...reduce(booted.state, failed(audio.token)));
    // alt-audio would follow the remaining variant onto the ac-3 group.
    settled = settle(
      reduce,
      ...reduce(settled.state, { type: 'SELECT_TRACK', trackId: 'ac3:English' }),
    );
    const ac3 = fetches(settled.effects, 'hls:pl:').find((f) => f.url.endsWith('audio-ac3.m3u8'));
    if (ac3 === undefined) throw new Error('the ac-3 audio was not fetched');
    settled = settle(reduce, ...reduce(settled.state, failed(ac3.token)));
    expect(settled.state.lifecycle.phase).toBe('error');
    const [, fx] = reduce(settled.state, { type: 'TICK', token: 'kernel:retry' });
    expect(fx.filter((e) => e.kind === 'fetch' || e.kind === 'schedule')).toEqual([]);
  });

  it('a failed playlist names its rendition, so steering can count it', () => {
    const booted = boot();
    for (const fetch of fetches(booted.effects, 'hls:pl:')) {
      expect(fetch.renditionId).toBeDefined();
    }
  });
});

describe('a live rendition loaded for the first time mid-stream', () => {
  it('joins the running timeline through a sibling in its track', () => {
    const window = (sequence: number, start: number): Segment[] =>
      [0, 1, 2, 3, 4].map((i) => ({
        seq: sequence + i,
        start: start + i * 4,
        duration: 4,
        url: `${BASE}low-${sequence + i}.m4s`,
      }));
    const presentation: Presentation = {
      id: `${BASE}master.m3u8`,
      isLive: true,
      couplings: [],
      periods: [
        {
          id: 'p0',
          start: 0,
          tracks: [
            {
              id: 'video-main',
              contentType: 'video',
              mimeType: 'video/mp4',
              protection: null,
              renditions: [
                {
                  id: 'low',
                  bitrate: 1,
                  codecs: null,
                  mimeType: 'video/mp4',
                  segments: window(100, 400),
                },
                { id: 'high', bitrate: 2, codecs: null, mimeType: 'video/mp4', segments: [] },
              ],
            },
          ],
        },
      ],
    };
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:102'];
    for (let i = 0; i < 5; i += 1) lines.push('#EXTINF:4.000,', `high-${102 + i}.m4s`);
    const playlist = parseMediaPlaylist(lines.join('\n'), `${BASE}high.m3u8`).playlist;
    if (playlist === null) throw new Error('playlist did not parse');
    const refresh = refreshFor(presentation, 'high', playlist);
    // Sequence 102 starts at 408 on the low rendition's timeline.
    expect(refresh?.segments[0]).toMatchObject({ seq: 102, start: 408 });
  });
});

describe('dash-cmaf resolves the indexes the selection needs', () => {
  const reduce = compose(dashCmaf);
  const MPD = readFileSync(
    join(import.meta.dirname, '../../fixtures/manifests/shaka-angel-one-segmentbase.mpd'),
    'utf8',
  );
  const SIDX = readFileSync(
    join(import.meta.dirname, '../../fixtures/segments/angel-one-video-sidx.bin'),
  );
  const sidx = () => SIDX.buffer.slice(SIDX.byteOffset, SIDX.byteOffset + SIDX.byteLength);

  function boot(): { state: KernelState; effects: Effect[] } {
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/angel/dash.mpd' });
    const token = [...state.scheduling.inflight.keys()][0] as string;
    return settle(reduce, ...reduce(state, loaded('manifest', bytes(MPD), token)));
  }

  it('at startup it resolves the playing video rendition, the rung above, and the audio ones', () => {
    const { effects } = boot();
    // Video 4 plays and 11 is the next rung; audio 5 and 10 are the active track's.
    expect(fetches(effects, 'dash:idx:').map((f) => f.token)).toEqual([
      'dash:idx:4',
      'dash:idx:11',
      'dash:idx:5',
      'dash:idx:10',
    ]);
  });

  it('answers that land before their merges never fetch an index twice', () => {
    const booted = boot();
    let state = booted.state;
    const produced: Effect[] = [];
    for (const fetch of fetches(booted.effects, 'dash:idx:')) {
      const [next, fx] = reduce(state, loaded(fetch.token, sidx()));
      state = next;
      produced.push(...fx);
    }
    const settled = settle(reduce, state, produced);
    const [, timeFx] = reduce(settled.state, { type: 'TIME_UPDATE', currentTime: 1, buffered: [] });
    const tokens = fetches([...booted.effects, ...settled.effects, ...timeFx], 'dash:idx:').map(
      (f) => f.token,
    );
    expect(tokens).toHaveLength(new Set(tokens).size);
    expect(segmentsOf(settled.state, '4').length).toBeGreaterThan(0);
    expect(segmentsOf(settled.state, '10').length).toBeGreaterThan(0);
  });

  it('an index with no segment is reported, excluded, and never fetched again', () => {
    const booted = boot();
    let settled = settle(
      reduce,
      ...reduce(booted.state, loaded('dash:idx:11', new ArrayBuffer(16))),
    );
    expect(settled.effects).toContainEqual(
      expect.objectContaining({
        kind: 'emit',
        event: 'error',
        payload: expect.objectContaining({ code: 'MEDIA_CONTAINER_INVALID', fatal: false }),
      }),
    );
    const all = [...settled.effects];
    for (let i = 1; i <= 20; i += 1) {
      const [next, fx] = reduce(settled.state, {
        type: 'TIME_UPDATE',
        currentTime: i / 4,
        buffered: [],
      });
      settled = settle(reduce, next, fx);
      all.push(...settled.effects);
    }
    expect(fetches(all, 'dash:idx:11')).toEqual([]);
    // Rendition 12 takes the excluded rung's place.
    expect(fetches(all, 'dash:idx:').map((f) => f.token)).toContain('dash:idx:12');
  });
});

describe('live reload failures are bounded', () => {
  function livePlaylist(mediaSequence: number): string {
    const lines = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
      '#EXT-X-MAP:URI="init.mp4"',
    ];
    for (let i = 0; i < 5; i += 1) lines.push('#EXTINF:4.000,', `seg-${mediaSequence + i}.m4s`);
    return lines.join('\n');
  }

  it('hls-live gives up on a target that keeps failing and fails the load', () => {
    const reduce = compose(hlsCmaf, hlsLive);
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/live.m3u8' });
    const token = [...state.scheduling.inflight.keys()][0] as string;
    ({ state } = settle(
      reduce,
      ...reduce(state, loaded('manifest', bytes(livePlaylist(5)), token)),
    ));
    const retries: Effect[] = [];
    for (let round = 1; round <= 4; round += 1) {
      let fx: readonly Effect[];
      [state, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
      expect(fetches(fx, 'hls:live:refresh:')).toHaveLength(1);
      ({ state, effects: fx } = settle(reduce, ...reduce(state, failed('hls:live:refresh:r-0'))));
      retries.push(...fx.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload'));
    }
    // Three retries on the short cadence, then the load fails.
    expect(retries).toHaveLength(3);
    expect(state.lifecycle.phase).toBe('error');
    const [, after] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    expect(after.filter((e) => e.kind === 'fetch' || e.kind === 'schedule')).toEqual([]);
  });

  it('hls-live abandons a variant whose reloads keep failing and reloads another', () => {
    const reduce = compose(hlsCmaf, hlsLive);
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401f,mp4a.40.2"',
      'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f,mp4a.40.2"',
      'high.m3u8',
    ].join('\n');
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/master.m3u8' });
    const token = [...state.scheduling.inflight.keys()][0] as string;
    let settled = settle(reduce, ...reduce(state, loaded('manifest', bytes(master), token)));
    for (const fetch of fetches(settled.effects, 'hls:pl:')) {
      settled = settle(
        reduce,
        ...reduce(settled.state, loaded(fetch.token, bytes(livePlaylist(5)))),
      );
    }
    state = settled.state;
    expect(state.quality.active).toBe('v-1000000');
    for (let round = 1; round <= 4; round += 1) {
      [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
      ({ state } = settle(reduce, ...reduce(state, failed('hls:live:refresh:v-1000000'))));
    }
    expect(state.lifecycle.phase).toBe('ready');
    expect(state.quality.constraints.get('hls-live:unavailable')?.excludeIds).toEqual([
      'v-1000000',
    ]);
    // The next tick reloads the variant playing now.
    const [ticked, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    expect(ticked.quality.active).toBe('v-3000000');
    expect(fetches(fx, 'hls:live:refresh:').map((f) => f.token)).toEqual([
      'hls:live:refresh:v-3000000',
    ]);
  });

  it('dash-live retries a failed MPD reload on the update period, then fails the load', () => {
    const reduce = compose(dashLive);
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/live.mpd' });
    const presentation: Presentation = {
      id: 'https://live.example/live.mpd',
      isLive: true,
      couplings: [],
      periods: [{ id: 'p0', start: 0, tracks: [] }],
      live: {
        availabilityStart: 1_700_000_000,
        updatePeriod: 4,
        timeServer: {
          scheme: 'urn:mpeg:dash:utc:http-xsdate:2014',
          value: 'https://time.example/',
        },
      },
    };
    ({ state } = settle(reduce, ...reduce(state, { type: 'MANIFEST_LOADED', presentation })));
    // No time server answer: the skew stays unknown and nothing waits on it.
    [state] = reduce(state, failed('dash:live:utc'));
    expect((state['dash-live'] as { utcPending: boolean }).utcPending).toBe(false);
    for (let round = 1; round <= 4; round += 1) {
      let fx: readonly Effect[];
      [state, fx] = reduce(state, { type: 'TICK', token: 'dash-live:reload' });
      expect(fetches(fx, 'dash:live:mpd')).toHaveLength(1);
      ({ state, effects: fx } = settle(reduce, ...reduce(state, failed('dash:live:mpd'))));
      if (round < 4) {
        expect(fx).toContainEqual(
          expect.objectContaining({ kind: 'schedule', token: 'dash-live:reload', delayMs: 4000 }),
        );
      }
    }
    expect(state.lifecycle.phase).toBe('error');
    const [, after] = reduce(state, { type: 'TICK', token: 'dash-live:clock' });
    expect(after.filter((e) => e.kind === 'fetch' || e.kind === 'schedule')).toEqual([]);
  });
});
