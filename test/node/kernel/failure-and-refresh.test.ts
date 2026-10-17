import { describe, expect, it } from 'vitest';
import type { BufferState, KernelState, Presentation, SliceReducer } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { applyRefresh } from '../../../src/kernel/refresh.js';
import { deepFreeze, readyStateWithInflight, vodFixture } from './helpers.js';

/** The fixture with its video rendition unresolved, the way a multivariant playlist leaves it. */
const unresolved: Presentation = {
  ...vodFixture,
  periods: vodFixture.periods.map((period) => ({
    ...period,
    tracks: period.tracks.map((track) => ({
      ...track,
      renditions: track.renditions.map((rendition) => ({ ...rendition, segments: [] })),
    })),
  })),
};

function ready(reduce: ReturnType<typeof createReducer>, presentation: Presentation): KernelState {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
  [state] = reduce(state, { type: 'MANIFEST_LOADED', presentation });
  return state;
}

function segmentsOf(state: KernelState, renditionId: string): unknown {
  for (const period of state.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) return rendition.segments;
      }
    }
  }
  return undefined;
}

const segment = (seq: number, prefix: string) => ({
  seq,
  start: seq * 4,
  duration: 4,
  url: `https://cdn.example/${prefix}/${seq}.m4s`,
});

describe('PLAYLIST_REFRESHED merges into the presentation the kernel holds', () => {
  const reduce = createReducer();

  it('two refreshes built from the same presentation both keep their segments', () => {
    // Both adapters' answers were computed before either merged. A full
    // presentation snapshot from the second would erase the first.
    const state = deepFreeze(ready(reduce, unresolved));
    const [first] = reduce(state, {
      type: 'PLAYLIST_REFRESHED',
      trackId: 'v-1',
      renditionId: 'v-1',
      mediaSequence: 0,
      segments: [segment(0, 'v'), segment(1, 'v')],
      endlist: true,
    });
    const [both] = reduce(first, {
      type: 'PLAYLIST_REFRESHED',
      trackId: 'a-1',
      renditionId: 'a-1',
      mediaSequence: 0,
      segments: [segment(0, 'a')],
      endlist: true,
    });
    expect(segmentsOf(both, 'v-1')).toHaveLength(2);
    expect(segmentsOf(both, 'a-1')).toHaveLength(1);
  });

  it('a complete playlist decides liveness and extends the duration', () => {
    const merged = applyRefresh(
      { ...unresolved, duration: 2 },
      {
        type: 'PLAYLIST_REFRESHED',
        trackId: 'v-1',
        renditionId: 'v-1',
        mediaSequence: 0,
        segments: [segment(0, 'v'), segment(1, 'v')],
        endlist: true,
      },
    );
    expect(merged?.isLive).toBe(false);
    expect(merged?.duration).toBe(8);
  });

  it('an open playlist makes the presentation live with its cadence', () => {
    const merged = applyRefresh(unresolved, {
      type: 'PLAYLIST_REFRESHED',
      trackId: 'v-1',
      renditionId: 'v-1',
      mediaSequence: 0,
      segments: [segment(0, 'v')],
      endlist: false,
      updatePeriod: 4,
    });
    expect(merged?.isLive).toBe(true);
    expect(merged?.live?.updatePeriod).toBe(4);
  });

  it('a refresh for a rendition the presentation lacks merges nothing and drives nothing', () => {
    const state = deepFreeze(ready(reduce, unresolved));
    const [next, fx] = reduce(state, {
      type: 'PLAYLIST_REFRESHED',
      trackId: 'gone',
      renditionId: 'gone',
      mediaSequence: 0,
      segments: [segment(0, 'v')],
    });
    expect(next).toBe(state);
    expect(fx).toEqual([]);
  });

  it('a merge drives scheduling: the rendition that just resolved is fetched from', () => {
    const state = ready(reduce, unresolved);
    const [, fx] = reduce(state, {
      type: 'PLAYLIST_REFRESHED',
      trackId: 'v-1',
      renditionId: 'v-1',
      mediaSequence: 0,
      segments: [segment(0, 'v')],
      init: { url: 'https://cdn.example/v/init.mp4' },
      endlist: true,
    });
    expect(fx).toContainEqual(
      expect.objectContaining({ kind: 'fetch', url: 'https://cdn.example/v/init.mp4' }),
    );
  });
});

describe('a failed engine starts nothing', () => {
  // A stage that asks for something on every message, the way a reload
  // loop or a retry would.
  const eager: SliceReducer = (slice, msg) => [
    slice,
    msg.type === 'TICK'
      ? [
          { kind: 'fetch', token: 'eager:fetch', url: 'https://cdn.example/again' },
          {
            kind: 'schedule',
            token: 'eager:tick',
            delayMs: 1000,
            // biome-ignore lint/suspicious/noThenProperty: the schedule effect's field name
            then: { type: 'TICK', token: 'eager:tick' },
          },
          { kind: 'emit', event: 'eager:ticked', payload: null },
        ]
      : [],
  ];
  const reduce = createReducer([['eager', eager]]);

  it('a stage working before the failure keeps working', () => {
    const state = ready(reduce, vodFixture);
    const [, fx] = reduce(state, { type: 'TICK', token: 'eager:tick' });
    expect(fx.map((e) => e.kind)).toEqual(expect.arrayContaining(['fetch', 'schedule', 'emit']));
  });

  it('after a fatal failure its fetches and timers are dropped, its reports kept', () => {
    let state = ready(reduce, vodFixture);
    [state] = reduce(state, {
      type: 'MANIFEST_FAILED',
      error: {
        category: 'manifest',
        code: 'MANIFEST_REFRESH_FAILED',
        fatal: true,
        recoverable: false,
      },
    });
    expect(state.lifecycle.phase).toBe('error');
    const [, fx] = reduce(state, { type: 'TICK', token: 'eager:tick' });
    expect(fx).toEqual([{ kind: 'emit', event: 'eager:ticked', payload: null }]);
  });

  it("the element's own error moves the kernel to error and aborts what is in flight", () => {
    const state = deepFreeze(ready(reduce, vodFixture));
    expect(state.scheduling.inflight.size).toBeGreaterThan(0);
    const [failed, fx] = reduce(state, {
      type: 'MEDIA_ERROR',
      error: {
        category: 'media',
        code: 'MEDIA_CODEC_UNSUPPORTED',
        fatal: true,
        recoverable: false,
        context: { mediaError: 'MEDIA_ERR_SRC_NOT_SUPPORTED', message: 'unsupported' },
      },
    });
    expect(failed.lifecycle.phase).toBe('error');
    expect(failed.scheduling.inflight.size).toBe(0);
    expect(fx.filter((e) => e.kind === 'abort')).toHaveLength(state.scheduling.inflight.size);
    expect(fx).toContainEqual({
      kind: 'emit',
      event: 'error',
      payload: {
        category: 'media',
        code: 'MEDIA_CODEC_UNSUPPORTED',
        fatal: true,
        recoverable: false,
        context: { mediaError: 'MEDIA_ERR_SRC_NOT_SUPPORTED', message: 'unsupported' },
      },
    });
    // A second report of the same failure changes nothing.
    const [again, againFx] = reduce(failed, {
      type: 'MEDIA_ERROR',
      error: { category: 'media', code: 'MEDIA_DECODE_ERROR', fatal: true, recoverable: false },
    });
    expect(again.lifecycle.phase).toBe('error');
    expect(againFx).toEqual([]);
  });

  it("an UNLOAD keeps the network's throughput estimate and drops the server's", () => {
    let state = ready(reduce, vodFixture);
    [state] = reduce(state, { type: 'THROUGHPUT_SAMPLE', bps: 4_000_000, trackId: 'video' });
    [state] = reduce(state, { type: 'THROUGHPUT_HINT', bps: 3_000_000 });
    const { throughputEwma, throughputFastEwma } = state.stats;
    expect(throughputEwma).toBeGreaterThan(0);
    [state] = reduce(state, { type: 'UNLOAD' });
    expect(state.stats).toEqual({ throughputEwma, throughputFastEwma });
  });

  it('an UNLOAD leaves the error phase and effects flow again', () => {
    let state = ready(reduce, vodFixture);
    [state] = reduce(state, {
      type: 'MEDIA_ERROR',
      error: { category: 'media', code: 'MEDIA_DECODE_ERROR', fatal: true, recoverable: false },
    });
    [state] = reduce(state, { type: 'UNLOAD' });
    expect(state.lifecycle.phase).not.toBe('error');
    const [, fx] = reduce(state, { type: 'TICK', token: 'eager:tick' });
    expect(fx.map((e) => e.kind)).toContain('fetch');
  });
});

describe('preload hints', () => {
  const reduce = createReducer();
  const hint = {
    token: 't1:v:2',
    trackId: 'v',
    seq: 2,
    url: 'https://cdn.example/v/2.0.m4s',
    renditionId: 'v-1',
    sbId: 'sb-v',
    segmentStart: 8,
    segmentDuration: 1,
    preload: true,
  } as const;

  it('a failed hint drops its request and reports nothing', () => {
    const state = readyStateWithInflight([hint]);
    const [next, fx] = reduce(state, {
      type: 'SEGMENT_FAILED',
      trackId: 'v',
      seq: 2,
      renditionId: 'v-1',
      preload: true,
      status: 404,
      error: { category: 'network', code: 'NETWORK_HTTP_STATUS', fatal: false, recoverable: true },
    });
    expect(next.scheduling.inflight.size).toBe(0);
    expect(fx).toEqual([]);
  });

  it('throughput takes the transfer the transport measured', () => {
    const state = readyStateWithInflight([hint]);
    const [next] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 2,
      token: hint.token,
      bytes: new ArrayBuffer(100_000),
      // Held 900 ms, then 100 ms to send 100 kB: 8 Mbps, not 0.8.
      rtt: 1000,
      transfer: { bytes: 100_000, ms: 100 },
      size: 100_000,
    });
    // The first sample seeds both estimates.
    expect(next.stats.throughputEwma).toBe(8_000_000);
  });
});

describe('chunked segments', () => {
  const reduce = createReducer();
  const chunked = {
    token: 't1:v:5',
    trackId: 'v',
    seq: 5,
    url: 'https://cdn.example/v/5.m4s',
    renditionId: 'v-1',
    sbId: 'sb-v',
    segmentStart: 20,
    segmentDuration: 4,
    epoch: 'e0',
    chunked: true,
  } as const;

  function initialized(): KernelState {
    const state = readyStateWithInflight([chunked]);
    const buffers = new Map(state.buffers);
    buffers.set('sb-v', { ...(state.buffers.get('sb-v') as BufferState), initFor: 'v-1' });
    return { ...state, buffers };
  }

  it('a chunk appends at once, at the offset its decode time settles', () => {
    const [next, fx] = reduce(initialized(), {
      type: 'SEGMENT_CHUNK',
      trackId: 'v',
      seq: 5,
      token: chunked.token,
      bytes: new ArrayBuffer(10),
      mediaStart: 120,
    });
    expect(fx).toEqual([
      { kind: 'setTimestampOffset', sbId: 'sb-v', offset: -100 },
      { kind: 'append', sbId: 'sb-v', data: expect.any(ArrayBuffer) },
    ]);
    expect(next.buffers.get('sb-v')?.pendingAppends).toBe(1);
    // The request stays in flight until the segment ends.
    expect(next.scheduling.inflight.has(chunked.token)).toBe(true);
  });

  it('the segment fact after its chunks appends no empty rest, and records the segment', () => {
    const [afterChunk] = reduce(initialized(), {
      type: 'SEGMENT_CHUNK',
      trackId: 'v',
      seq: 5,
      token: chunked.token,
      bytes: new ArrayBuffer(10),
      mediaStart: 120,
    });
    const [next, fx] = reduce(afterChunk, {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 5,
      token: chunked.token,
      bytes: new ArrayBuffer(0),
      rtt: 4000,
      size: 50_000,
      transfer: { bytes: 0, ms: 0 },
    });
    expect(fx.some((effect) => effect.kind === 'append')).toBe(false);
    expect(fx.some((effect) => effect.kind === 'setTimestampOffset')).toBe(false);
    expect(next.scheduling.inflight.has(chunked.token)).toBe(false);
    expect(next.buffers.get('sb-v')?.appended).toEqual([
      { renditionId: 'v-1', seq: 5, start: 20, end: 24 },
    ]);
    // Only the chunk's append is pending: one the reducer never emitted
    // would hold scheduling forever.
    expect(next.buffers.get('sb-v')?.pendingAppends).toBe(1);
    // Nothing measured the link, so the estimate holds.
    expect(next.stats).toBe(afterChunk.stats);
  });

  it('a chunk of a rendition without its init in the buffer waits for the segment', () => {
    const [next, fx] = reduce(readyStateWithInflight([chunked]), {
      type: 'SEGMENT_CHUNK',
      trackId: 'v',
      seq: 5,
      token: chunked.token,
      bytes: new ArrayBuffer(10),
    });
    expect(fx).toEqual([]);
    expect(next.buffers.get('sb-v')?.pendingAppends).toBe(0);
  });

  it('a chunk of an aborted request is dropped', () => {
    const state = initialized();
    const [next, fx] = reduce(state, {
      type: 'SEGMENT_CHUNK',
      trackId: 'v',
      seq: 5,
      token: 'gone',
      bytes: new ArrayBuffer(10),
    });
    expect(next).toBe(state);
    expect(fx).toEqual([]);
  });
});
