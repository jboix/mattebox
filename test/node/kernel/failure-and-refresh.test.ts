import { describe, expect, it } from 'vitest';
import type { KernelState, Presentation, SliceReducer } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { applyRefresh } from '../../../src/kernel/refresh.js';
import { deepFreeze, vodFixture } from './helpers.js';

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
