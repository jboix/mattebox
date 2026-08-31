import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import dashLive from '../../../src/protocols/dash-live/index.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import hlsLive from '../../../src/protocols/hls-live/index.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { Stage } from '../../../src/types/stage.js';

function compose(...factories: Array<() => Stage>) {
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
  reduce: ReturnType<typeof createReducer>,
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

function livePlaylist(mediaSequence: number, count: number, endlist = false, prefix = ''): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  for (let i = 0; i < count; i += 1) {
    lines.push('#EXTINF:4.000,', `${prefix}seg-${mediaSequence + i}.m4s`);
  }
  if (endlist) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function bootHls(reduce: ReturnType<typeof createReducer>) {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/live.m3u8' });
  const [next, fx] = reduce(state, {
    type: 'SEGMENT_LOADED',
    trackId: 'manifest',
    seq: 0,
    bytes: bytes(livePlaylist(5, 5)),
    rtt: 5,
    size: 500,
  });
  return settle(reduce, next, fx);
}

describe('hls-live', () => {
  const reduce = compose(hlsCmaf, hlsLive);

  it('a live manifest yields a window fact and a reload tick', () => {
    const { state, effects } = bootHls(reduce);
    // Segments seq 5..9 cover [0, 20): parse assigns start 0 to the first.
    expect(state.live).toEqual({ span: { start: 0, end: 20 }, edge: 8 });
    const ticks = effects.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ delayMs: 4000 });
    expect(state.lifecycle.phase).toBe('ready');
  });

  it('the tick refetches; a changed reload keeps the cadence, an unchanged one halves it', () => {
    let { state } = bootHls(reduce);
    const [ticked, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    state = ticked;
    expect(fx).toContainEqual(
      expect.objectContaining({ kind: 'fetch', token: 'hls:live:refresh:r-0' }),
    );

    // Changed: the window advanced by one segment.
    let settled = settle(
      reduce,
      ...(() => {
        const [next, effects] = reduce(state, {
          type: 'SEGMENT_LOADED',
          trackId: 'hls:live:refresh:r-0',
          seq: 0,
          bytes: bytes(livePlaylist(6, 5)),
          rtt: 5,
          size: 500,
        });
        return [next, effects] as const;
      })(),
    );
    state = settled.state;
    const changedTick = settled.effects.find(
      (e) => e.kind === 'schedule' && e.token === 'hls-live:reload',
    );
    expect(changedTick).toMatchObject({ delayMs: 4000 });
    expect(
      settled.effects.some(
        (e) => e.kind === 'schedule' && (e.then as Message).type === 'PLAYLIST_REFRESHED',
      ),
    ).toBe(true);

    // Unchanged: same end sequence halves the wait.
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    settled = settle(
      reduce,
      ...(() => {
        const [next, effects] = reduce(state, {
          type: 'SEGMENT_LOADED',
          trackId: 'hls:live:refresh:r-0',
          seq: 0,
          bytes: bytes(livePlaylist(6, 5)),
          rtt: 5,
          size: 500,
        });
        return [next, effects] as const;
      })(),
    );
    const halvedTick = settled.effects.find(
      (e) => e.kind === 'schedule' && e.token === 'hls-live:reload',
    );
    expect(halvedTick).toMatchObject({ delayMs: 2000 });
  });

  it('the active audio playlist reloads as a companion on the same tick', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="French",LANGUAGE="fr",DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
      'video.m3u8',
    ].join('\n');
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/master.m3u8' });
    let settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'manifest',
        seq: 0,
        bytes: bytes(master),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    // hls-cmaf fetches both media playlists; answer them.
    const playlistFetches = settled.effects.filter(
      (e) => e.kind === 'fetch' && e.token.startsWith('hls:pl:'),
    );
    expect(playlistFetches).toHaveLength(2);
    for (const fetch of playlistFetches) {
      settled = settle(
        reduce,
        ...reduce(state, {
          type: 'SEGMENT_LOADED',
          trackId: (fetch as { token: string }).token,
          seq: 0,
          bytes: bytes(livePlaylist(5, 5)),
          rtt: 5,
          size: 500,
        }),
      );
      state = settled.state;
    }
    const audioId = 'aud:French';
    const audioSegments = (id: string) => {
      for (const period of state.presentation?.periods ?? []) {
        for (const track of period.tracks) {
          for (const rendition of track.renditions) {
            if (rendition.id === id) return rendition.segments as ReadonlyArray<{ seq: number }>;
          }
        }
      }
      return [];
    };
    expect(audioSegments(audioId).map((s) => s.seq)).toEqual([5, 6, 7, 8, 9]);

    // The tick reloads the video playlist and the audio companion.
    const [ticked, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    state = ticked;
    expect(fx).toContainEqual(
      expect.objectContaining({
        kind: 'fetch',
        token: 'hls:live:refresh:v-1000000',
        url: 'https://live.example/video.m3u8',
      }),
    );
    expect(fx).toContainEqual(
      expect.objectContaining({
        kind: 'fetch',
        token: `hls:live:refresh:${audioId}`,
        url: 'https://live.example/audio.m3u8',
      }),
    );

    // The audio reload merges into the audio rendition and fires no tick of its own.
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: `hls:live:refresh:${audioId}`,
        seq: 0,
        bytes: bytes(livePlaylist(7, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    expect(audioSegments(audioId).map((s) => s.seq)).toEqual([7, 8, 9, 10, 11]);
    expect(
      settled.effects.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload'),
    ).toEqual([]);
  });

  it('a switch of the window rendition reloads its playlist before reporting a window', () => {
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
    let settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'manifest',
        seq: 0,
        bytes: bytes(master),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    for (const fetch of settled.effects.filter(
      (e) => e.kind === 'fetch' && e.token.startsWith('hls:pl:'),
    )) {
      settled = settle(
        reduce,
        ...reduce(state, {
          type: 'SEGMENT_LOADED',
          trackId: (fetch as { token: string }).token,
          seq: 0,
          bytes: bytes(livePlaylist(5, 5)),
          rtt: 5,
          size: 500,
        }),
      );
      state = settled.state;
    }
    const before = state.live;
    expect(before).not.toBeNull();
    // The high playlist reloads alongside as a ladder companion on the
    // first tick, so a switch can land on it.
    const [, firstTickFx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    expect(firstTickFx).toContainEqual(
      expect.objectContaining({
        kind: 'fetch',
        token: 'hls:live:refresh:v-3000000',
        url: 'https://live.example/high.m3u8',
      }),
    );

    // Time passes: the low playlist (the window rendition) reloads twice and
    // its edge advances, while the high playlist stays as fetched at startup.
    for (const seq of [7, 9]) {
      [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
      settled = settle(
        reduce,
        ...reduce(state, {
          type: 'SEGMENT_LOADED',
          trackId: 'hls:live:refresh:v-1000000',
          seq: 0,
          bytes: bytes(livePlaylist(seq, 5)),
          rtt: 5,
          size: 500,
        }),
      );
      state = settled.state;
    }
    const advanced = state.live as { span: { end: number } };
    expect(advanced.span.end).toBeGreaterThan((before as { span: { end: number } }).span.end);

    // ABR moves to the high rendition; the next reload notices the switch.
    [state] = reduce(state, { type: 'PIN_RENDITION', renditionId: 'v-3000000', apply: 'next' });
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:v-1000000',
        seq: 0,
        bytes: bytes(livePlaylist(11, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    // The stale high playlist does not pull the window back...
    expect((state.live as { span: { end: number } }).span.end).toBe(advanced.span.end);
    // ...and its reload is requested at once.
    expect(settled.effects).toContainEqual(
      expect.objectContaining({
        kind: 'fetch',
        token: 'hls:live:refresh:v-3000000',
        url: 'https://live.example/high.m3u8',
      }),
    );
    // Once it lands, the window follows the fresh edge.
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:v-3000000',
        seq: 0,
        bytes: bytes(livePlaylist(12, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    expect((state.live as { span: { end: number } }).span.end).toBeGreaterThan(advanced.span.end);
  });

  it('a reload older than the known window is ignored', () => {
    let { state } = bootHls(reduce);
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    let settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:r-0',
        seq: 0,
        bytes: bytes(livePlaylist(8, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    const fresh = (state.live as { span: { end: number } }).span.end;
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:r-0',
        seq: 0,
        bytes: bytes(livePlaylist(6, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    expect((settled.state.live as { span: { end: number } }).span.end).toBe(fresh);
  });

  it('ENDLIST converts to VOD and the loop dies', () => {
    let { state } = bootHls(reduce);
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    const [next, fx] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'hls:live:refresh:r-0',
      seq: 0,
      bytes: bytes(livePlaylist(5, 5, true)),
      rtt: 5,
      size: 500,
    });
    const settled = settle(reduce, next, fx);
    expect(settled.state.presentation?.isLive).toBe(false);
    expect(settled.state.presentation?.duration).toBe(20);
    const [, tickFx] = reduce(settled.state, { type: 'TICK', token: 'hls-live:reload' });
    expect(tickFx.filter((e) => e.kind === 'fetch')).toEqual([]);
  });

  it('a late reload for the previous target merges into its own rendition after a switch', () => {
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
    let settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'manifest',
        seq: 0,
        bytes: bytes(master),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    for (const fetch of settled.effects.filter(
      (e) => e.kind === 'fetch' && e.token.startsWith('hls:pl:'),
    )) {
      const token = (fetch as { token: string }).token;
      const prefix = token.endsWith('v-3000000') ? 'high/' : 'low/';
      settled = settle(
        reduce,
        ...reduce(state, {
          type: 'SEGMENT_LOADED',
          trackId: token,
          seq: 0,
          bytes: bytes(livePlaylist(5, 5, false, prefix)),
          rtt: 5,
          size: 500,
        }),
      );
      state = settled.state;
    }
    const urls = (id: string): string[] => {
      for (const period of state.presentation?.periods ?? []) {
        for (const track of period.tracks) {
          for (const rendition of track.renditions) {
            if (rendition.id === id && Array.isArray(rendition.segments)) {
              return rendition.segments.map((s) => s.url);
            }
          }
        }
      }
      return [];
    };
    expect(urls('v-1000000').every((u) => u.includes('/low/'))).toBe(true);
    expect(urls('v-3000000').every((u) => u.includes('/high/'))).toBe(true);

    // The low target's reload goes out...
    const [ticked, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    state = ticked;
    expect(fx).toContainEqual(
      expect.objectContaining({ kind: 'fetch', token: 'hls:live:refresh:v-1000000' }),
    );
    const held = state.live;
    // ...and while it is in flight ABR moves to high. Any playlist landing
    // now (here the high companion of the same tick) notices the switch.
    [state] = reduce(state, { type: 'PIN_RENDITION', renditionId: 'v-3000000', apply: 'next' });
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:v-3000000',
        seq: 0,
        bytes: bytes(livePlaylist(6, 5, false, 'high/')),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    expect(settled.effects).toContainEqual(
      expect.objectContaining({
        kind: 'fetch',
        token: 'hls:live:refresh:v-3000000',
        url: 'https://live.example/high.m3u8',
      }),
    );

    // The late low reload lands under the low token: it merges into low,
    // never into the new target, moves no window and schedules no tick.
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:v-1000000',
        seq: 0,
        bytes: bytes(livePlaylist(9, 5, false, 'low/')),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    expect(urls('v-1000000').every((u) => u.includes('/low/'))).toBe(true);
    expect(urls('v-3000000').every((u) => u.includes('/high/'))).toBe(true);
    expect(state.live).toEqual(held);
    expect(
      settled.effects.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload'),
    ).toEqual([]);

    // The new target's reload lands: the window follows it and the loop ticks.
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:v-3000000',
        seq: 0,
        bytes: bytes(livePlaylist(10, 5, false, 'high/')),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    expect(urls('v-3000000').every((u) => u.includes('/high/'))).toBe(true);
    expect((state.live as { span: { end: number } }).span.end).toBeGreaterThan(
      (held as { span: { end: number } }).span.end,
    );
    expect(
      settled.effects.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload'),
    ).toHaveLength(1);
  });

  it('one target reload is in flight at a time and only its answer ticks', () => {
    let { state } = bootHls(reduce);
    const targetFetches = (fx: readonly Effect[]) =>
      fx.filter((e) => e.kind === 'fetch' && e.token === 'hls:live:refresh:r-0');
    let fx: readonly Effect[];
    [state, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    expect(targetFetches(fx)).toHaveLength(1);
    // A second tick before the answer does not fetch the target again.
    [state, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    expect(targetFetches(fx)).toHaveLength(0);
    // A manifest fed while the loop is armed (a companion's reload) arms no
    // second loop and, with the window unchanged, reports no window.
    const presentation = state.presentation as Presentation;
    const [, fedFx] = reduce(state, { type: 'MANIFEST_LOADED', presentation });
    expect(fedFx.filter((e) => e.kind === 'schedule')).toEqual([]);
    // The answer schedules exactly one tick.
    const settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:r-0',
        seq: 0,
        bytes: bytes(livePlaylist(6, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    expect(
      settled.effects.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload'),
    ).toHaveLength(1);
  });

  it('a switch while a tick is pending reloads the new target without forking the loop', () => {
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
    let settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'manifest',
        seq: 0,
        bytes: bytes(master),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    for (const fetch of settled.effects.filter(
      (e) => e.kind === 'fetch' && e.token.startsWith('hls:pl:'),
    )) {
      settled = settle(
        reduce,
        ...reduce(state, {
          type: 'SEGMENT_LOADED',
          trackId: (fetch as { token: string }).token,
          seq: 0,
          bytes: bytes(livePlaylist(5, 5)),
          rtt: 5,
          size: 500,
        }),
      );
      state = settled.state;
    }
    const ticks = (fx: readonly Effect[]) =>
      fx.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload');
    // The first tick is pending from startup. A pin switches the window
    // rendition; the next manifest (any companion's) reloads high at once.
    [state] = reduce(state, { type: 'PIN_RENDITION', renditionId: 'v-3000000', apply: 'next' });
    const presentation = state.presentation as Presentation;
    let fx: readonly Effect[];
    [state, fx] = reduce(state, { type: 'MANIFEST_LOADED', presentation });
    expect(fx).toContainEqual(
      expect.objectContaining({ kind: 'fetch', token: 'hls:live:refresh:v-3000000' }),
    );
    expect(ticks(fx)).toEqual([]);
    // Its answer moves the window but schedules no second tick.
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:v-3000000',
        seq: 0,
        bytes: bytes(livePlaylist(7, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    state = settled.state;
    expect(ticks(settled.effects)).toEqual([]);
    expect((state.live as { span: { end: number } }).span.end).toBe(7 * 4 + 20 - 20);
    // The pending tick fires, reloads the new target, and that answer
    // schedules the one next tick.
    [state, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    expect(
      fx.filter((e) => e.kind === 'fetch' && e.token === 'hls:live:refresh:v-3000000'),
    ).toHaveLength(1);
    settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'hls:live:refresh:v-3000000',
        seq: 0,
        bytes: bytes(livePlaylist(8, 5)),
        rtt: 5,
        size: 500,
      }),
    );
    expect(ticks(settled.effects)).toHaveLength(1);
  });

  it('the scheduler fetches only segments fully inside the window', () => {
    const { state } = bootHls(reduce);
    // An initialized buffer and empty inflight, so media scheduling runs;
    // shrink the window so the last segment [16, 20) sticks out.
    const primed: KernelState = {
      ...state,
      buffers: new Map([
        ['sb:video', { codecs: 'video/mp4', ranges: [], pendingAppends: 0, initFor: 'r-0' }],
      ]),
      scheduling: { ...state.scheduling, inflight: new Map() },
      playback: { currentTime: 14, buffered: [], seeking: false },
    };
    // The window fact drives scheduling itself.
    const [, fx] = reduce(primed, {
      type: 'LIVE_WINDOW_CHANGED',
      start: 0,
      end: 18,
      edge: 10,
    });
    const urls = fx.filter((e) => e.kind === 'fetch').map((e) => (e as { url: string }).url);
    // The segment at 14 s ([12, 16)) fits; [16, 20) must not be fetched.
    expect(urls.some((u) => u.includes('seg-8'))).toBe(true);
    expect(urls.some((u) => u.includes('seg-9'))).toBe(false);
  });

  it('SEEK_TO_LIVE_EDGE lands on the reported edge', () => {
    const { state } = bootHls(reduce);
    const [, fx] = reduce(state, { type: 'SEEK_TO_LIVE_EDGE' });
    expect(fx).toContainEqual({ kind: 'seekElement', to: 8 });
  });
});

describe('hls-cmaf media playlists follow selection', () => {
  const reduce = compose(hlsCmaf);

  it('selecting a track whose playlist is not loaded fetches it without waiting for time to move', () => {
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://vod.example/master.m3u8' });
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",SUBTITLES="subs"',
      'top.m3u8',
    ].join('\n');
    const [next, fx] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'manifest',
      seq: 0,
      bytes: bytes(master),
      rtt: 5,
      size: master.length,
    });
    const booted = settle(reduce, next, fx);
    const playlistFetches = (effects: readonly Effect[]) =>
      effects
        .filter((e): e is Extract<Effect, { kind: 'fetch' }> => e.kind === 'fetch')
        .filter((e) => e.token.startsWith('hls:pl:'))
        .map((e) => e.url);
    // Only the active variant's playlist loads with the master.
    expect(playlistFetches(booted.effects)).toEqual(['https://vod.example/top.m3u8']);

    const subs = booted.state.presentation?.periods[0]?.tracks.find(
      (t) => t.contentType === 'text',
    );
    expect(subs).toBeDefined();
    // A paused or stalled element fires no TIME_UPDATE; the selection itself
    // must be enough to fetch the subtitle playlist.
    const [, selectFx] = reduce(booted.state, {
      type: 'SELECT_TRACK',
      trackId: (subs as { id: string }).id,
    });
    expect(playlistFetches(selectFx)).toEqual(['https://vod.example/subs.m3u8']);
  });
});

describe('dash-live', () => {
  const reduce = compose(dashLive);
  const AST = 1_700_000_000;

  function dynamicPresentation(): Presentation {
    return {
      id: 'https://live.example/live.mpd',
      isLive: true,
      periods: [
        {
          id: 'p0',
          start: 0,
          tracks: [
            {
              id: 'as-0',
              contentType: 'video',
              mimeType: 'video/mp4',
              protection: null,
              renditions: [
                {
                  id: '0',
                  bitrate: 150_000,
                  codecs: 'avc1.42c00d',
                  mimeType: 'video/mp4',
                  segments: {
                    kind: 'indexed',
                    urlTemplate: 'https://live.example/$Number$.m4s',
                    startSeq: 1,
                    endSeq: null,
                    timescale: 1000,
                    segmentDuration: 4000,
                    timeline: null,
                  },
                },
              ],
            },
          ],
        },
      ],
      couplings: [],
      live: {
        availabilityStart: AST,
        updatePeriod: 4,
        timeShiftDepth: 20,
        holdBack: 6,
        timeServer: {
          scheme: 'urn:mpeg:dash:utc:http-xsdate:2014',
          value: 'https://time.example/now',
        },
      },
    };
  }

  function bootDash() {
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/live.mpd' });
    const [next, fx] = reduce(state, {
      type: 'MANIFEST_LOADED',
      presentation: dynamicPresentation(),
    });
    return settle(reduce, next, fx);
  }

  it('an HLS live presentation without an availability start drives no DASH loop', () => {
    const hlsPresentation: Presentation = {
      ...dynamicPresentation(),
      id: 'https://live.example/master.m3u8',
      live: { updatePeriod: 4 },
    };
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/master.m3u8' });
    const [next, fx] = reduce(state, { type: 'MANIFEST_LOADED', presentation: hlsPresentation });
    const dashEffects = fx.filter(
      (e) =>
        (e.kind === 'fetch' && e.token.startsWith('dash:')) ||
        (e.kind === 'schedule' && e.token.startsWith('dash-live:')),
    );
    expect(dashEffects).toEqual([]);
    for (const token of ['dash-live:clock', 'dash-live:reload']) {
      const [, tickFx] = reduce(next, { type: 'TICK', token });
      expect(tickFx).toEqual([]);
    }
  });

  it('UTCTiming is fetched once and the skew comes from the response pair', () => {
    const { state, effects } = bootDash();
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: 'fetch', token: 'dash:live:utc' }),
    );
    // The server is 10 s ahead of the client.
    const clientNow = AST + 30;
    const [, fx] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'dash:live:utc',
      seq: 0,
      bytes: bytes(new Date((clientNow + 10) * 1000).toISOString()),
      rtt: 5,
      size: 30,
      wallClock: clientNow,
    });
    expect(fx).toEqual([]);
    // The next wall-clock fact computes the window with the corrected clock.
    const [afterSkew] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'dash:live:utc',
      seq: 0,
      bytes: bytes(new Date((clientNow + 10) * 1000).toISOString()),
      rtt: 5,
      size: 30,
      wallClock: clientNow,
    });
    const [windowState] = (() => {
      const [next, fx2] = reduce(afterSkew, {
        type: 'TIME_UPDATE',
        currentTime: 0,
        buffered: [],
        wallClock: clientNow,
      });
      const settled = settle(reduce, next, fx2);
      return [settled.state] as const;
    })();
    // end = clientNow + skew(10) - AST = 40; start = 40 - 20; edge = 40 - 6.
    expect(windowState.live).toEqual({ span: { start: 20, end: 40 }, edge: 34 });
  });

  it('the window slides on wall-clock facts and quantizes small movement', () => {
    const { state } = bootDash();
    const step = (s: KernelState, wallClock: number) => {
      const [next, fx] = reduce(s, {
        type: 'TIME_UPDATE',
        currentTime: 0,
        buffered: [],
        wallClock,
      });
      return settle(reduce, next, fx).state;
    };
    const first = step(state, AST + 30);
    expect(first.live?.span.end).toBe(30);
    // 0.2 s later: below the quantum, no new fact, same window.
    const second = step(first, AST + 30.2);
    expect(second.live?.span.end).toBe(30);
    const third = step(second, AST + 31);
    expect(third.live?.span.end).toBe(31);
  });
});

describe('the ended phase', () => {
  const reduce = createReducer();

  it('ENDED moves ready to ended and emits; seeking out restores ready', () => {
    let state: KernelState = { ...initialState(), lifecycle: { phase: 'ready' } };
    const [ended, fx] = reduce(state, { type: 'ENDED', at: 72 });
    state = ended;
    expect(state.lifecycle.phase).toBe('ended');
    expect(fx).toContainEqual(expect.objectContaining({ kind: 'emit', event: 'playback:ended' }));
    [state] = reduce(state, { type: 'SEEKING', to: 10 });
    expect(state.lifecycle.phase).toBe('ready');
  });
});
