import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';

const reduce = createReducer([]);

function live(duration?: number): Presentation {
  return {
    id: 'live',
    isLive: true,
    ...(duration !== undefined ? { duration } : {}),
    periods: [{ id: 'p0', start: 0, tracks: [] }],
    couplings: [],
  };
}

function ready(presentation: Presentation): KernelState {
  return { ...initialState(), lifecycle: { phase: 'ready' }, presentation };
}

describe('live window: the DVR span reaches the element', () => {
  it('the first window sets an infinite duration and the seekable range', () => {
    const [state, effects] = reduce(ready(live()), {
      type: 'LIVE_WINDOW_CHANGED',
      start: 3600,
      end: 7200,
      edge: 7190,
    });
    expect(effects).toContainEqual({ kind: 'setDuration', seconds: Number.POSITIVE_INFINITY });
    expect(effects).toContainEqual({ kind: 'setLiveSeekableRange', start: 3600, end: 7200 });
    // Duration is published before the range and the edge seek, so the
    // seekable attribute already means the window when the seek lands.
    const kinds = effects.map((e) => e.kind);
    expect(kinds.indexOf('setDuration')).toBeLessThan(kinds.indexOf('setLiveSeekableRange'));
    expect(kinds.indexOf('setLiveSeekableRange')).toBeLessThan(kinds.indexOf('seekElement'));
    expect(state.live).toEqual({ span: { start: 3600, end: 7200 }, edge: 7190 });
  });

  it('later windows republish the range and leave the duration alone', () => {
    const [first] = reduce(ready(live()), {
      type: 'LIVE_WINDOW_CHANGED',
      start: 3600,
      end: 7200,
      edge: 7190,
    });
    const [, effects] = reduce(first, {
      type: 'LIVE_WINDOW_CHANGED',
      start: 3610,
      end: 7210,
      edge: 7200,
    });
    expect(effects).toContainEqual({ kind: 'setLiveSeekableRange', start: 3610, end: 7210 });
    expect(effects.filter((e) => e.kind === 'setDuration')).toEqual([]);
  });

  it('a declared duration is kept: only the range is published', () => {
    const [, effects] = reduce(ready(live(7200)), {
      type: 'LIVE_WINDOW_CHANGED',
      start: 0,
      end: 7200,
      edge: 7190,
    });
    expect(effects.filter((e) => e.kind === 'setDuration')).toEqual([]);
    expect(effects).toContainEqual({ kind: 'setLiveSeekableRange', start: 0, end: 7200 });
  });

  it('SEEK is clamped into the window, with the edge as the far bound', () => {
    const [state] = reduce(ready(live()), {
      type: 'LIVE_WINDOW_CHANGED',
      start: 3600,
      end: 7200,
      edge: 7190,
    });
    const [, behind] = reduce(state, { type: 'SEEK', to: 100 });
    expect(behind).toContainEqual({ kind: 'seekElement', to: 3600 });
    const [, ahead] = reduce(state, { type: 'SEEK', to: 99_999 });
    expect(ahead).toContainEqual({ kind: 'seekElement', to: 7190 });
    const [, inside] = reduce(state, { type: 'SEEK', to: 5000 });
    expect(inside).toContainEqual({ kind: 'seekElement', to: 5000 });
  });
});
