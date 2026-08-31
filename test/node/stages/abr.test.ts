import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import abr from '../../../src/stages/abr/index.js';
import type { Presentation, Rendition } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { AbrChooser } from '../../../src/types/quality.js';
import type { StageContext } from '../../../src/types/stage.js';

function segments(count: number, base: string) {
  return Array.from({ length: count }, (_, i) => ({
    seq: i,
    start: i * 4,
    duration: 4,
    url: `${base}/${i}.m4s`,
  }));
}

function rendition(id: string, bitrate: number, height: number, codecs = 'avc1.64001f'): Rendition {
  return {
    id,
    bitrate,
    height,
    width: Math.round((height * 16) / 9),
    codecs,
    mimeType: 'video/mp4',
    segments: segments(5, `https://cdn.example/${id}`),
  };
}

const ladder: Presentation = {
  id: 'ladder',
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
            rendition('v-low', 300_000, 180),
            rendition('v-mid', 1_000_000, 360),
            rendition('v-high', 3_000_000, 720),
          ],
        },
      ],
    },
  ],
  couplings: [],
};

/** Installs the abr stage the way the lifecycle does, without a browser. */
function composeWithAbr(options?: Parameters<typeof abr>[0]) {
  const slices: Array<readonly [string, SliceReducer]> = [];
  const hooks: { abr?: AbrChooser } = {};
  abr(options).install({
    element: {} as HTMLMediaElement,
    registerSink: () => undefined,
    registerParser: () => undefined,
    registerTransform: () => undefined,
    registerNamespace: () => undefined,
    getState: () => initialState(),
    addRequestHook: () => () => undefined,
    request: async () => new Response(),
    registerChooser: (chooser) => {
      hooks.abr = chooser;
    },
    registerSwitchPolicy: () => undefined,
    registerTypeProbe: () => undefined,
    reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
    dispatch: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
  } satisfies StageContext);
  return { reduce: createReducer(slices, undefined, hooks), hooks };
}

/** A ready state on the ladder with a buffered span and empty inflight. */
function readyState(bufferAhead: number, active: string | null): KernelState {
  const base = initialState();
  return {
    ...base,
    lifecycle: { phase: 'ready' },
    presentation: ladder,
    buffers: new Map([
      [
        'sb:video',
        {
          codecs: 'avc1.64001f',
          ranges: bufferAhead > 0 ? [{ start: 0, end: bufferAhead }] : [],
          pendingAppends: 0,
          ...(active !== null ? { initFor: active } : {}),
        },
      ],
    ]),
    tracks: { active: new Map([['video', 'v']]), available: ['v'] },
    quality: { ...base.quality, active },
  };
}

function run(
  reduce: ReturnType<typeof createReducer>,
  state: KernelState,
  messages: readonly Message[],
): { state: KernelState; effects: Effect[] } {
  let current = state;
  const effects: Effect[] = [];
  for (const msg of messages) {
    const [next, fx] = reduce(current, msg);
    current = next;
    effects.push(...fx);
  }
  return { state: current, effects };
}

describe('1. the EWMA pair converges on a synthetic series', () => {
  it('both averages approach a steady series; the fast one falls first on collapse', () => {
    const reduce = createReducer();
    let state = initialState();
    for (let i = 0; i < 12; i += 1) {
      [state] = reduce(state, { type: 'THROUGHPUT_SAMPLE', bps: 4_000_000, trackId: 'v' });
    }
    expect(state.stats.throughputEwma).toBeGreaterThan(3_500_000);
    expect(state.stats.throughputFastEwma).toBeGreaterThan(3_900_000);

    [state] = reduce(state, { type: 'THROUGHPUT_SAMPLE', bps: 300_000, trackId: 'v' });
    [state] = reduce(state, { type: 'THROUGHPUT_SAMPLE', bps: 300_000, trackId: 'v' });
    // Two bad samples: the fast average has collapsed, the slow one rides it out.
    expect(state.stats.throughputFastEwma).toBeLessThan(1_000_000);
    expect(state.stats.throughputEwma).toBeGreaterThan(2_000_000);
  });
});

describe('2. choose() stays inside the allowed set', () => {
  it('every telemetry shape yields a member of allowed', () => {
    const { hooks } = composeWithAbr();
    const chooser = hooks.abr as AbrChooser;
    const allowed = [rendition('v-low', 300_000, 180), rendition('v-mid', 1_000_000, 360)];
    const shapes = [
      { throughputEwma: 0, currentTime: 0 },
      {
        throughputEwma: 50_000_000,
        throughputFastEwma: 50_000_000,
        bufferAhead: 60,
        currentTime: 5,
      },
      {
        throughputEwma: 1,
        throughputFastEwma: 1,
        bufferAhead: 0,
        current: 'v-mid',
        currentTime: 1,
      },
      { throughputEwma: 700_000, current: 'not-in-set', currentTime: 2 },
    ];
    for (const telemetry of shapes) {
      const choice = chooser.choose(allowed, telemetry);
      expect(allowed.map((r) => r.id)).toContain(choice);
    }
  });
});

describe('3. a misbehaving chooser is rejected by arbitration', () => {
  it('an out-of-set choice falls back with a warning event', () => {
    const reduce = createReducer([], undefined, {
      abr: { choose: () => 'bogus-rendition' },
    });
    const { state, effects } = run(reduce, readyState(0, null), [
      { type: 'TIME_UPDATE', currentTime: 0, buffered: [] },
    ]);
    expect(state.quality.active).toBe('v-low');
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'quality:abr-invalid' }),
    );
  });
});

describe('4 and 5. the emergency floor composes with other sources', () => {
  function collapse() {
    const { reduce } = composeWithAbr();
    let state = readyState(12, 'v-high');
    // A user constraint registered first; the emergency must not touch it.
    [state] = reduce(state, {
      type: 'CONSTRAIN',
      source: 'user',
      constraint: { maxHeight: 720 },
    });
    const before = state.quality.constraints;
    // Healthy samples, then a collapse well below the active bitrate.
    ({ state } = run(
      reduce,
      state,
      Array.from({ length: 6 }, () => ({
        type: 'THROUGHPUT_SAMPLE' as const,
        bps: 4_000_000,
        trackId: 'v',
      })),
    ));
    const { state: collapsed, effects } = run(reduce, state, [
      { type: 'THROUGHPUT_SAMPLE', bps: 200_000, trackId: 'v' },
      { type: 'THROUGHPUT_SAMPLE', bps: 200_000, trackId: 'v' },
      { type: 'THROUGHPUT_SAMPLE', bps: 200_000, trackId: 'v' },
    ]);
    const scheduled = effects.find((e) => e.kind === 'schedule');
    return { reduce, before, collapsed, scheduled };
  }

  it('registers abr-emergency as its own source, leaving the user source intact', () => {
    const { reduce, collapsed, scheduled } = collapse();
    expect(scheduled).toBeDefined();
    const command = (scheduled as Extract<Effect, { kind: 'schedule' }>).then;
    expect(command).toMatchObject({ type: 'CONSTRAIN', source: 'abr-emergency' });

    const [applied] = reduce(collapsed, command);
    expect([...applied.quality.constraints.keys()]).toEqual(['user', 'abr-emergency']);
    expect(applied.quality.constraints.get('user')).toEqual({ maxHeight: 720 });
  });

  it('recovery releases the emergency source and restores the prior set exactly', () => {
    const { reduce, before, collapsed, scheduled } = collapse();
    const command = (scheduled as Extract<Effect, { kind: 'schedule' }>).then;
    let [state] = reduce(collapsed, command);

    const { state: recovered, effects } = run(
      reduce,
      state,
      Array.from({ length: 5 }, () => ({
        type: 'THROUGHPUT_SAMPLE' as const,
        bps: 5_000_000,
        trackId: 'v',
      })),
    );
    const release = effects.find((e) => e.kind === 'schedule');
    expect(release).toBeDefined();
    const releaseCommand = (release as Extract<Effect, { kind: 'schedule' }>).then;
    expect(releaseCommand).toMatchObject({ type: 'RELEASE_CONSTRAINT', source: 'abr-emergency' });
    [state] = reduce(recovered, releaseCommand);
    expect([...state.quality.constraints.entries()]).toEqual([...before.entries()]);
  });
});

describe('4b. the emergency trigger samples only media of the active track', () => {
  function healthy() {
    const { reduce } = composeWithAbr();
    let state = readyState(12, 'v-high');
    ({ state } = run(
      reduce,
      state,
      Array.from({ length: 6 }, () => ({
        type: 'THROUGHPUT_SAMPLE' as const,
        bps: 4_000_000,
        trackId: 'v',
      })),
    ));
    return { reduce, state };
  }
  const slow = (trackId: string, seq: number): Message => ({
    type: 'SEGMENT_LOADED',
    trackId,
    seq,
    bytes: new ArrayBuffer(0),
    rtt: 8000,
    size: 200_000,
  });
  const emergencies = (effects: readonly Effect[]) =>
    effects.filter(
      (e) => e.kind === 'schedule' && (e.then as { source?: string }).source === 'abr-emergency',
    );

  it('ignores playlist reloads and segments of other tracks', () => {
    const { reduce, state } = healthy();
    const { effects } = run(reduce, state, [
      slow('hls:live:refresh:v-low', -1),
      slow('hls:live:refresh:v-low', -1),
      slow('hls:live:refresh:v-low', -1),
      slow('a', 0),
      slow('a', 1),
      slow('a', 2),
    ]);
    expect(emergencies(effects)).toEqual([]);
  });

  it('still trips on slow media segments of the active track', () => {
    const { reduce, state } = healthy();
    const { effects } = run(reduce, state, [slow('v', 0), slow('v', 1), slow('v', 2)]);
    expect(emergencies(effects).length).toBeGreaterThan(0);
  });
});

describe('6. a reloading switch is declined', () => {
  it('stays on the current codec family rather than forcing a flush', () => {
    const { hooks } = composeWithAbr();
    const chooser = hooks.abr as AbrChooser;
    const allowed = [
      rendition('v-low', 300_000, 180, 'avc1.64001f'),
      rendition('v-ultra', 3_000_000, 1080, 'vp09.00.41.08'),
    ];
    const choice = chooser.choose(allowed, {
      throughputEwma: 20_000_000,
      throughputFastEwma: 20_000_000,
      bufferAhead: 30,
      current: 'v-low',
      currentTime: 10,
    });
    expect(choice).toBe('v-low');
  });
});

describe('7. abr is genuinely optional', () => {
  it('no chooser, no slices: the lowest permitted rendition plays', () => {
    const reduce = createReducer();
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
    const [ready, effects] = reduce(state, { type: 'MANIFEST_LOADED', presentation: ladder });
    expect(ready.lifecycle.phase).toBe('ready');
    expect(ready.quality.active).toBe('v-low');
    const fetches = effects.filter((e) => e.kind === 'fetch');
    expect(fetches.some((f) => (f as { url: string }).url.includes('v-low'))).toBe(true);
  });

  it('with abr loaded and a healthy buffer, the same state switches up', () => {
    const { reduce } = composeWithAbr();
    let state = readyState(12, 'v-low');
    ({ state } = run(
      reduce,
      state,
      Array.from({ length: 8 }, () => ({
        type: 'THROUGHPUT_SAMPLE' as const,
        bps: 5_000_000,
        trackId: 'v',
      })),
    ));
    const [driven] = reduce(state, { type: 'TIME_UPDATE', currentTime: 1, buffered: [] });
    expect(driven.quality.active).toBe('v-high');
  });
});
