import { describe, expect, it } from 'vitest';
import type { Effect, KernelState, Presentation, SliceReducer } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { deepFreeze, vodFixture } from './helpers.js';

const reduce = createReducer();

function ready(presentation: Presentation): { state: KernelState; manifestFx: readonly Effect[] } {
  const base = initialState();
  let state = base;
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
  const [loaded, manifestFx] = reduce(state, { type: 'MANIFEST_LOADED', presentation });
  return { state: loaded, manifestFx };
}

describe('the buffer-goal loop on TIME_UPDATE', () => {
  it('creates buffers and fetches for the active tracks at manifest time', () => {
    const { state: next, manifestFx: fx } = ready(vodFixture);
    const kinds = fx.map((e) => e.kind);
    expect(kinds).toContain('createSourceBuffer');
    expect(kinds).toContain('fetch');
    // One fetch per active media track: video and audio.
    expect(fx.filter((e) => e.kind === 'fetch')).toHaveLength(2);
    expect(next.scheduling.inflight.size).toBe(2);
    // The arbitrated rendition is recorded as active.
    expect(next.quality.active).toBe('v-1');
    const request = [...next.scheduling.inflight.values()].find((r) => r.trackId === 'v');
    expect(request).toMatchObject({ sbId: 'sb:video', renditionId: 'v-1', segmentStart: 0 });
  });

  it('does not burst: a TIME_UPDATE with requests in flight adds nothing', () => {
    const { state: afterFirst } = ready(vodFixture);
    const [, fx] = reduce(deepFreeze(structuredClone(afterFirst)), {
      type: 'TIME_UPDATE',
      currentTime: 0.1,
      buffered: [],
    });
    expect(fx.filter((e) => e.kind === 'fetch')).toHaveLength(0);
    expect(fx.filter((e) => e.kind === 'createSourceBuffer')).toHaveLength(0);
  });

  it('schedules nothing for a live presentation until a live stage owns the bounds', () => {
    const live: Presentation = { ...vodFixture, isLive: true };
    const { state, manifestFx } = ready(live);
    expect(manifestFx.filter((e) => e.kind === 'fetch')).toEqual([]);
    const [, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'TIME_UPDATE',
      currentTime: 0,
      buffered: [],
    });
    expect(fx).toEqual([]);
  });

  it('schedules nothing outside the ready phase', () => {
    const [, fx] = reduce(deepFreeze(structuredClone(initialState())), {
      type: 'TIME_UPDATE',
      currentTime: 0,
      buffered: [],
    });
    expect(fx).toEqual([]);
  });

  it('a satisfied buffer goal produces no effects', () => {
    const { state } = ready(vodFixture);
    const withBuffers: KernelState = {
      ...state,
      scheduling: { ...state.scheduling, inflight: new Map() },
      buffers: new Map([
        ['sb:video', { codecs: 'avc1', ranges: [{ start: 0, end: 40 }], pendingAppends: 0 }],
        ['sb:audio', { codecs: 'mp4a', ranges: [{ start: 0, end: 40 }], pendingAppends: 0 }],
      ]),
    };
    const [, fx] = reduce(deepFreeze(structuredClone(withBuffers)), {
      type: 'TIME_UPDATE',
      currentTime: 1,
      buffered: [{ start: 0, end: 40 }],
    });
    expect(fx).toEqual([]);
  });
});

describe('what a buffer remembers receiving', () => {
  const longVod: Presentation = {
    ...vodFixture,
    periods: vodFixture.periods.map((period) => ({
      ...period,
      tracks: period.tracks.map((track) =>
        track.id !== 'v'
          ? track
          : {
              ...track,
              renditions: track.renditions.map((rendition) => ({
                ...rendition,
                segments: [0, 1, 2, 3, 4, 5].map((seq) => ({
                  seq,
                  start: seq * 4,
                  duration: 4,
                  url: `https://cdn.example/v1/${seq}.m4s`,
                })),
              })),
            },
      ),
    })),
  };

  const segment = (seq: number) => ({ renditionId: 'v-1', seq, start: seq * 4, end: seq * 4 + 4 });

  function buffered(
    currentTime: number,
    ranges: ReadonlyArray<{ start: number; end: number }>,
    appended: ReadonlyArray<ReturnType<typeof segment>>,
  ): KernelState {
    const { state } = ready(longVod);
    return {
      ...state,
      playback: { ...state.playback, currentTime },
      scheduling: { ...state.scheduling, inflight: new Map() },
      buffers: new Map([
        ['sb:video', { codecs: 'avc1', ranges, pendingAppends: 1, appended }],
        ['sb:audio', { codecs: 'mp4a', ranges: [{ start: 0, end: 40 }], pendingAppends: 0 }],
      ]),
    };
  }

  function fetched(fx: readonly Effect[]): string[] {
    return fx.flatMap((e) => (e.kind === 'fetch' ? [e.url] : []));
  }

  it('records a media segment with its span, once', () => {
    const base = buffered(4.2, [], [segment(1)]);
    const request = {
      token: 't9:v:1',
      trackId: 'v',
      seq: 1,
      url: 'https://cdn.example/v1/1.m4s',
      renditionId: 'v-1',
      segmentStart: 4,
      segmentDuration: 4,
      sbId: 'sb:video',
    };
    const state: KernelState = {
      ...base,
      scheduling: { ...base.scheduling, inflight: new Map([[request.token, request]]) },
    };
    const [next] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 1,
      token: request.token,
      bytes: new ArrayBuffer(8),
      rtt: 0,
      size: 8,
    });
    expect(next.buffers.get('sb:video')?.appended).toEqual([segment(1)]);
  });

  it('a flush forgets the segments it removed, and the scheduler fetches them again', () => {
    // A switch away and back: the flush took segments 2 and 3, and the
    // buffer received both of this rendition since the last seek.
    const state = buffered(1, [{ start: 0, end: 16 }], [0, 1, 2, 3].map(segment));
    const [next, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb:video',
      ranges: [{ start: 0, end: 8 }],
    });
    expect(next.buffers.get('sb:video')?.appended?.map((s) => s.seq)).toEqual([0]);
    expect(fetched(fx)).toEqual(['https://cdn.example/v1/2.m4s']);
  });

  it('forward buffer the evictor dropped under quota is fetched again', () => {
    const state = buffered(1, [{ start: 0, end: 24 }], [0, 1, 2, 3, 4, 5].map(segment));
    const [, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb:video',
      ranges: [{ start: 0, end: 11 }],
    });
    // Segment 2 keeps its midpoint, so it still counts as consumed.
    expect(fetched(fx)).toEqual(['https://cdn.example/v1/3.m4s']);
  });

  it('a removal elsewhere leaves a segment that kept only a sliver remembered', () => {
    // Segment 1 left 7.8 onward. The back-buffer trim does not touch it.
    const state = buffered(
      4.2,
      [
        { start: 0, end: 3 },
        { start: 7.8, end: 16 },
      ],
      [1, 2, 3].map(segment),
    );
    const [next, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb:video',
      ranges: [{ start: 7.8, end: 16 }],
    });
    expect(next.buffers.get('sb:video')?.appended?.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(fetched(fx)).toEqual(['https://cdn.example/v1/4.m4s']);
  });

  it('a range the browser rounded down is not a removal', () => {
    const state = buffered(1, [{ start: 0, end: 16 }], [0, 1, 2, 3].map(segment));
    const [next] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb:video',
      ranges: [{ start: 0, end: 15.9 }],
    });
    expect(next.buffers.get('sb:video')?.appended?.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
  });

  it('a buffer error forgets the segment that failed, and it is fetched again', () => {
    const state = buffered(4.2, [], [segment(1)]);
    const [failed] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_ERROR',
      sbId: 'sb:video',
      error: { category: 'media', code: 'MEDIA_APPEND_FAILED', fatal: false, recoverable: true },
    });
    expect(failed.buffers.get('sb:video')?.appended).toBeUndefined();
    const [, fx] = reduce(deepFreeze(structuredClone(failed)), {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb:video',
      ranges: [],
    });
    expect(fetched(fx)).toEqual(['https://cdn.example/v1/1.m4s']);
  });

  it('a flush forgets a segment that left nothing, from its start onward', () => {
    // Segment 1 left no range, so no lost content can point at it. The
    // flush starts before it: appended after segment 0 again it would
    // land whole, so it must be fetched again.
    const flusher: SliceReducer = (slice, msg) => [
      slice,
      msg.type === 'STALLED'
        ? [{ kind: 'remove', sbId: 'sb:video', start: 0, end: Number.POSITIVE_INFINITY }]
        : [],
    ];
    const flushing = createReducer([['flusher', flusher]]);
    const state = buffered(1, [{ start: 0, end: 4 }], [0, 1].map(segment));
    const [flushed] = flushing(deepFreeze(structuredClone(state)), { type: 'STALLED', at: 1 });
    expect(flushed.buffers.get('sb:video')?.appended).toEqual([]);
    // A bounded removal is eviction, and reports through its updateend.
    const [evicted] = reduce(
      deepFreeze(structuredClone({ ...state, playback: { ...state.playback, currentTime: 40 } })),
      {
        type: 'QUOTA_EXCEEDED',
        sbId: 'sb:video',
      },
    );
    expect(evicted.buffers.get('sb:video')?.appended?.map((s) => s.seq)).toEqual([0, 1]);
  });

  it('a transform that threw reports for its append, and the segment is fetched again', () => {
    // No append reached the buffer, so no updateend follows this error.
    const state = buffered(4.2, [], [segment(1)]);
    const [failed, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_ERROR',
      sbId: 'sb:video',
      error: {
        category: 'media',
        code: 'MEDIA_CONTAINER_INVALID',
        fatal: false,
        recoverable: false,
      },
    });
    expect(failed.buffers.get('sb:video')?.pendingAppends).toBe(0);
    // The retry waits a backoff, as a failed fetch does.
    expect(fx).toContainEqual({
      kind: 'schedule',
      token: 'kernel:retry',
      delayMs: 400,
      // biome-ignore lint/suspicious/noThenProperty: the schedule effect's field name
      then: { type: 'TICK', token: 'kernel:retry' },
    });
    const [, retryFx] = reduce(deepFreeze(structuredClone(failed)), {
      type: 'TICK',
      token: 'kernel:retry',
    });
    expect(fetched(retryFx)).toEqual(['https://cdn.example/v1/1.m4s']);
  });

  it('a parser error leaves its append to the updateend that follows it', () => {
    const state = buffered(4.2, [], [segment(1)]);
    const [failed, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_ERROR',
      sbId: 'sb:video',
      error: { category: 'media', code: 'MEDIA_APPEND_FAILED', fatal: false, recoverable: true },
    });
    expect(failed.buffers.get('sb:video')?.pendingAppends).toBe(1);
    expect(fx.filter((e) => e.kind === 'schedule')).toEqual([]);
  });
});
