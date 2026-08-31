import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import contentSteering from '../../../src/stages/content-steering/index.js';
import recovery from '../../../src/stages/recovery/index.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { Stage } from '../../../src/types/stage.js';

function compose(...stages: Stage[]) {
  const slices: Array<readonly [string, SliceReducer]> = [];
  for (const stage of stages) {
    stage.install({
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

function ladder(): Presentation {
  const segs = (base: string) =>
    Array.from({ length: 5 }, (_, i) => ({
      seq: i,
      start: i * 4,
      duration: 4,
      url: `https://cdn.example/${base}/${i}.m4s`,
    }));
  return {
    id: 'p',
    isLive: false,
    duration: 20,
    periods: [
      {
        id: 'p0',
        start: 0,
        tracks: [
          {
            id: 'v',
            contentType: 'video',
            mimeType: 'video/mp4',
            protection: null,
            renditions: [
              {
                id: 'v-low',
                bitrate: 300_000,
                codecs: 'avc1.42c01e',
                mimeType: 'video/mp4',
                segments: segs('low'),
              },
              {
                id: 'v-high',
                bitrate: 900_000,
                codecs: 'avc1.42c015',
                mimeType: 'video/mp4',
                segments: segs('high'),
              },
            ],
          },
        ],
      },
    ],
    couplings: [],
  };
}

function ready(): KernelState {
  const base = initialState();
  return {
    ...base,
    lifecycle: { phase: 'ready' },
    presentation: ladder(),
    buffers: new Map([
      ['sb:video', { codecs: 'avc1', ranges: [], pendingAppends: 0, initFor: 'v-low' }],
    ]),
    tracks: { active: new Map([['video', 'v']]), available: ['v'] },
    quality: { ...base.quality, active: 'v-low' },
  };
}

function fail(seq: number, renditionId: string): Message {
  return {
    type: 'SEGMENT_FAILED',
    trackId: 'v',
    seq,
    renditionId,
    status: 404,
    error: { category: 'network', code: 'NETWORK_HTTP_STATUS', fatal: false, recoverable: true },
  };
}

describe('recovery: rendition exclusion', () => {
  const reduce = compose(recovery());

  it('two failures exclude the rendition under the recovery source, composing with others', () => {
    let state = ready();
    [state] = reduce(state, { type: 'CONSTRAIN', source: 'user', constraint: { maxHeight: 720 } });
    let settled = settle(reduce, ...reduce(state, fail(0, 'v-low')));
    expect([...settled.state.quality.constraints.keys()]).toEqual(['user']);
    settled = settle(reduce, ...reduce(settled.state, fail(0, 'v-low')));
    expect([...settled.state.quality.constraints.keys()]).toEqual(['user', 'recovery']);
    expect(settled.state.quality.constraints.get('recovery')).toEqual({
      excludeIds: ['v-low'],
    });
    expect(settled.state.quality.constraints.get('user')).toEqual({ maxHeight: 720 });
    // The readmission backoff is scheduled.
    expect(
      settled.effects.some((e) => e.kind === 'schedule' && e.token === 'recovery:readmit'),
    ).toBe(true);
  });

  it('arbitration switches away from the excluded rendition', () => {
    const state = ready();
    let settled = settle(reduce, ...reduce(state, fail(0, 'v-low')));
    settled = settle(reduce, ...reduce(settled.state, fail(0, 'v-low')));
    const [driven] = reduce(settled.state, { type: 'TIME_UPDATE', currentTime: 0, buffered: [] });
    expect(driven.quality.active).toBe('v-high');
  });

  it('readmission restores the rendition and clears the source when empty', () => {
    const state = ready();
    let settled = settle(reduce, ...reduce(state, fail(0, 'v-low')));
    settled = settle(reduce, ...reduce(settled.state, fail(0, 'v-low')));
    settled = settle(reduce, ...reduce(settled.state, { type: 'TICK', token: 'recovery:readmit' }));
    expect(settled.state.quality.constraints.has('recovery')).toBe(false);
  });

  it('the escalation stays visible: exclusion emits its event', () => {
    const state = ready();
    let settled = settle(reduce, ...reduce(state, fail(0, 'v-low')));
    settled = settle(reduce, ...reduce(settled.state, fail(0, 'v-low')));
    expect(settled.effects).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'recovery:excluded' }),
    );
  });
});

describe('recovery: content holes', () => {
  const reduce = compose(recovery());

  it('a segment failing across renditions is seeked over', () => {
    const state = ready();
    let settled = settle(reduce, ...reduce(state, fail(1, 'v-low')));
    settled = settle(reduce, ...reduce(settled.state, fail(1, 'v-low')));
    settled = settle(reduce, ...reduce(settled.state, fail(1, 'v-high')));
    // Segment 1 covers [4, 8): the third failure seeks past it.
    expect(settled.effects).toContainEqual(
      expect.objectContaining({ kind: 'seekElement', to: 8.1 }),
    );
    expect(settled.effects).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'recovery:skip' }),
    );
  });
});

describe('recovery: stalls', () => {
  const reduce = compose(recovery());

  it('a small hole ahead of the playhead is jumped once, never twice', () => {
    const state: KernelState = {
      ...ready(),
      playback: {
        currentTime: 3.9,
        buffered: [
          { start: 0, end: 4 },
          { start: 4.6, end: 12 },
        ],
        seeking: false,
      },
    };
    let settled = settle(reduce, ...reduce(state, { type: 'STALLED', at: 4 }));
    const jump = settled.effects.find((e) => e.kind === 'seekElement');
    expect((jump as { to: number } | undefined)?.to ?? 0).toBeCloseTo(4.7);
    // The same hole again: no second jump.
    settled = settle(reduce, ...reduce(settled.state, { type: 'STALLED', at: 4 }));
    expect(settled.effects.filter((e) => e.kind === 'seekElement')).toEqual([]);
  });

  it('a stall with data ahead nudges on the second occurrence only', () => {
    const state: KernelState = {
      ...ready(),
      playback: { currentTime: 2, buffered: [{ start: 0, end: 12 }], seeking: false },
    };
    const first = settle(reduce, ...reduce(state, { type: 'STALLED', at: 2 }));
    expect(first.effects.filter((e) => e.kind === 'seekElement')).toEqual([]);
    const second = settle(reduce, ...reduce(first.state, { type: 'STALLED', at: 2 }));
    expect(second.effects).toContainEqual(
      expect.objectContaining({ kind: 'seekElement', to: 2.1 }),
    );
  });

  it('a stall that survives the nudge is flushed and refetched, then skipped', () => {
    const state: KernelState = {
      ...ready(),
      playback: { currentTime: 2, buffered: [{ start: 0, end: 12 }], seeking: false },
    };
    let settled = settle(reduce, ...reduce(state, { type: 'STALLED', at: 2 }));
    settled = settle(reduce, ...reduce(settled.state, { type: 'STALLED', at: 2 }));
    // Third stall at the same spot: the buffer from the playhead is dropped
    // and the seek re-drives a clean refill.
    const third = settle(reduce, ...reduce(settled.state, { type: 'STALLED', at: 2.05 }));
    expect(third.effects).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'recovery:flush' }),
    );
    expect(third.effects).toContainEqual(
      expect.objectContaining({ kind: 'remove', sbId: 'sb:video', start: 2.05 }),
    );
    expect(third.effects).toContainEqual(
      expect.objectContaining({ kind: 'seekElement', to: 2.05 }),
    );
    // Fourth: the same bytes stalled again, so the segment covering the
    // playhead (0 to 4) is skipped.
    const fourth = settle(reduce, ...reduce(third.state, { type: 'STALLED', at: 2.05 }));
    expect(fourth.effects).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'recovery:skip' }),
    );
    const skip = fourth.effects.find((e) => e.kind === 'seekElement');
    expect((skip as { to: number } | undefined)?.to ?? 0).toBeCloseTo(4.1);
    // Fifth: out of rungs, no further seeks from this spot.
    const fifth = settle(reduce, ...reduce(fourth.state, { type: 'STALLED', at: 2.05 }));
    expect(fifth.effects.filter((e) => e.kind === 'seekElement')).toEqual([]);
    // Progress elsewhere starts a fresh ladder.
    const elsewhere = settle(reduce, ...reduce(fifth.state, { type: 'STALLED', at: 9 }));
    expect(elsewhere.effects.filter((e) => e.kind === 'seekElement')).toEqual([]);
  });
});

describe('recovery: buffer errors', () => {
  const reduce = compose(recovery());

  it('one flush-and-refetch before the kernel breaker', () => {
    const error = {
      category: 'media',
      code: 'MEDIA_APPEND_FAILED',
      fatal: false,
      recoverable: false,
    } as const;
    const state = ready();
    let settled = settle(
      reduce,
      ...reduce(state, { type: 'SOURCEBUFFER_ERROR', sbId: 'sb:video', error }),
    );
    expect(settled.effects.filter((e) => e.kind === 'remove')).toEqual([]);
    settled = settle(
      reduce,
      ...reduce(settled.state, { type: 'SOURCEBUFFER_ERROR', sbId: 'sb:video', error }),
    );
    expect(settled.effects).toContainEqual(
      expect.objectContaining({ kind: 'remove', sbId: 'sb:video' }),
    );
    expect(settled.effects).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'recovery:flush' }),
    );
    expect(settled.state.lifecycle.phase).toBe('ready');
  });
});

describe('content steering', () => {
  function steeringPresentation(): Presentation {
    const base = ladder();
    const track = base.periods[0]?.tracks[0];
    if (track === undefined) throw new Error('fixture');
    return {
      ...base,
      periods: [
        {
          ...(base.periods[0] as Presentation['periods'][number]),
          tracks: [
            {
              ...track,
              renditions: [
                { ...(track.renditions[0] as object), id: 'v-a', pathway: 'a' },
                { ...(track.renditions[1] as object), id: 'v-b', pathway: 'b' },
              ] as never,
            },
          ],
        },
      ],
      steering: { serverUri: 'https://steer.example/manifest.json', defaultPathway: 'a' },
    };
  }

  const reduce = compose(contentSteering());

  function boot() {
    const state: KernelState = {
      ...ready(),
      presentation: steeringPresentation(),
      quality: { ...ready().quality, active: 'v-a' },
    };
    return settle(
      reduce,
      ...reduce(state, { type: 'MANIFEST_LOADED', presentation: steeringPresentation() }),
    );
  }

  it('the default pathway applies and the steering manifest is fetched', () => {
    const { state, effects } = boot();
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: 'fetch', token: 'steering:manifest' }),
    );
    expect(state.quality.constraints.get('steering')).toEqual({ excludeIds: ['v-b'] });
  });

  it('the steering manifest reorders pathways', () => {
    const { state } = boot();
    const manifest = JSON.stringify({ VERSION: 1, TTL: 100, 'PATHWAY-PRIORITY': ['b', 'a'] });
    const settled = settle(
      reduce,
      ...reduce(state, {
        type: 'SEGMENT_LOADED',
        trackId: 'steering:manifest',
        seq: 0,
        bytes: new TextEncoder().encode(manifest).buffer as ArrayBuffer,
        rtt: 5,
        size: manifest.length,
      }),
    );
    expect(settled.state.quality.constraints.get('steering')).toEqual({ excludeIds: ['v-a'] });
  });

  it('failures on the active pathway fail over to the next', () => {
    const { state } = boot();
    let settled = settle(reduce, ...reduce(state, fail(0, 'v-a')));
    settled = settle(reduce, ...reduce(settled.state, fail(0, 'v-a')));
    expect(settled.effects).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'steering:failover' }),
    );
    expect(settled.state.quality.constraints.get('steering')).toEqual({ excludeIds: ['v-a'] });
  });
});
