import { describe, expect, it } from 'vitest';
import type { Effect, KernelState, Presentation } from '../../../src/index.js';
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
