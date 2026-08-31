import { describe, expect, it } from 'vitest';
import type { Constraint, Effect, KernelState, Rendition } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import type { ArbitrationContext } from '../../../src/kernel/rendition-select.js';
import { arbitrate, canSwitchTo, createArbiter } from '../../../src/kernel/rendition-select.js';
import { deepFreeze } from './helpers.js';

const r240: Rendition = {
  id: 'v-240',
  bitrate: 400_000,
  width: 426,
  height: 240,
  codecs: 'avc1.42c01e',
  mimeType: 'video/mp4',
  segments: [],
};
const r360: Rendition = { ...r240, id: 'v-360', bitrate: 800_000, width: 640, height: 360 };
const r720: Rendition = {
  ...r240,
  id: 'v-720',
  bitrate: 2_500_000,
  width: 1280,
  height: 720,
  codecs: 'hvc1.1.6.L93',
};

const RENDITIONS = [r240, r360, r720];

function ctx(overrides: Partial<ArbitrationContext> = {}): ArbitrationContext {
  return {
    renditions: RENDITIONS,
    constraints: new Map(),
    pinned: null,
    current: null,
    couplings: [],
    activeTracks: new Map(),
    telemetry: { throughputEwma: 0, currentTime: 0 },
    ...overrides,
  };
}

function constraints(entries: Array<[string, Constraint]>): Map<string, Constraint> {
  return new Map(entries);
}

function eventNames(events: readonly Effect[]): string[] {
  return events.map((e) => (e.kind === 'emit' ? e.event : e.kind));
}

describe('the arbitration matrix', () => {
  it('1. a single constraint narrows the allowed set', () => {
    const { result } = arbitrate(ctx({ constraints: constraints([['user', { maxHeight: 360 }]]) }));
    expect(result.allowed).toEqual(['v-240', 'v-360']);
    expect(result.selected).toBe('v-240');
    expect(result.reason).toBe('lowest-permitted');
  });

  it('2. four simultaneous sources intersect', () => {
    const { result } = arbitrate(
      ctx({
        constraints: constraints([
          ['user', { maxHeight: 720 }],
          ['saver', { maxBitrate: 1_000_000 }],
          ['element-size', { maxWidth: 700 }],
          ['abr-floor', { minBitrate: 500_000 }],
        ]),
      }),
    );
    expect(result.allowed).toEqual(['v-360']);
    expect(result.droppedConstraints).toEqual([]);
  });

  it('3. releasing one source restores exactly its exclusions', () => {
    const base = constraints([
      ['user', { maxHeight: 360 }],
      ['saver', { maxBitrate: 500_000 }],
    ]);
    expect(arbitrate(ctx({ constraints: base })).result.allowed).toEqual(['v-240']);

    const released = new Map(base);
    released.delete('saver');
    expect(arbitrate(ctx({ constraints: released })).result.allowed).toEqual(['v-240', 'v-360']);
  });

  it('4. unsatisfiable constraints drop in reverse registration order, never yielding empty', () => {
    const { result, events } = arbitrate(
      ctx({
        constraints: constraints([
          ['first', { maxHeight: 360 }],
          ['second', { minBitrate: 600_000 }],
          ['third', { maxBitrate: 500_000 }],
        ]),
      }),
    );
    // second ∩ third is empty; third registered last, so it drops first.
    expect(result.droppedConstraints).toEqual(['third']);
    expect(result.allowed).toEqual(['v-360']);
    expect(result.selected).toBe('v-360');
    expect(eventNames(events)).toContain('quality:constraints-unsatisfiable');
  });

  it('4b. even mutually impossible constraints resolve by dropping until playable', () => {
    const { result } = arbitrate(
      ctx({
        constraints: constraints([
          ['a', { minBitrate: 10_000_000 }],
          ['b', { maxBitrate: 1 }],
        ]),
      }),
    );
    expect(result.allowed.length).toBeGreaterThan(0);
    expect(result.droppedConstraints).toEqual(['b', 'a']);
  });

  it('5. a pin above the top of the allowed set clamps to the top, with a warning', () => {
    const { result, events } = arbitrate(
      ctx({ pinned: 'v-720', constraints: constraints([['user', { maxHeight: 360 }]]) }),
    );
    expect(result.selected).toBe('v-360');
    expect(result.reason).toBe('pin');
    expect(eventNames(events)).toContain('quality:pin-unsatisfiable');
  });

  it('6. a pin below the bottom clamps to the bottom, with a warning', () => {
    const { result, events } = arbitrate(
      ctx({ pinned: 'v-240', constraints: constraints([['floor', { minBitrate: 700_000 }]]) }),
    );
    expect(result.selected).toBe('v-360');
    expect(eventNames(events)).toContain('quality:pin-unsatisfiable');
  });

  it('7. a pin excluded by a later constraint loses to the constraint, warning emitted', () => {
    const { result, events } = arbitrate(
      ctx({ pinned: 'v-720', constraints: constraints([['saver', { maxBitrate: 900_000 }]]) }),
    );
    expect(result.allowed).not.toContain('v-720');
    expect(result.selected).toBe('v-360');
    expect(eventNames(events)).toContain('quality:pin-unsatisfiable');
  });

  it('8. the coupling table refuses a switch that would orphan the active audio', () => {
    const { result } = arbitrate(
      ctx({
        couplings: [
          { renditionId: 'v-720', requires: { audio: 'aac-hi' } },
          { renditionId: 'v-360', requires: { audio: 'aac-low' } },
        ],
        activeTracks: new Map([['audio', 'aac-low']]),
        telemetry: { throughputEwma: 99_000_000, currentTime: 0 },
        abr: { choose: () => 'v-720' },
      }),
    );
    // v-720 requires aac-hi while aac-low is active: not in the allowed set.
    expect(result.allowed).not.toContain('v-720');
    expect(result.selected).not.toBe('v-720');
  });

  it('9. no abr registered: lowest permitted at startup, stable thereafter', () => {
    const first = arbitrate(ctx());
    expect(first.result.selected).toBe('v-240');
    expect(first.result.reason).toBe('lowest-permitted');

    const later = arbitrate(ctx({ current: 'v-240' }));
    expect(later.result.selected).toBe('v-240');
    expect(later.result.reason).toBe('unchanged');
  });

  it('10. a registered abr chooses, from within the allowed set', () => {
    const { result } = arbitrate(
      ctx({
        constraints: constraints([['user', { maxHeight: 720 }]]),
        abr: { choose: (allowed) => allowed[allowed.length - 1]?.id ?? '' },
      }),
    );
    expect(result.selected).toBe('v-720');
    expect(result.reason).toBe('abr');
  });

  it('11. an abr choice outside the allowed set is rejected with a fallback and an event', () => {
    const { result, events } = arbitrate(
      ctx({
        current: 'v-360',
        constraints: constraints([['user', { maxHeight: 360 }]]),
        abr: { choose: () => 'v-720' },
      }),
    );
    expect(eventNames(events)).toContain('quality:abr-invalid');
    expect(result.selected).toBe('v-360');
    expect(result.reason).toBe('unchanged');
  });

  it('codecs allowlists and the filter escape hatch constrain too', () => {
    const { result } = arbitrate(
      ctx({ constraints: constraints([['app', { codecs: ['hvc1'] }]]) }),
    );
    expect(result.allowed).toEqual(['v-720']);

    const filtered = arbitrate(
      ctx({ constraints: constraints([['app', { filter: (r) => r.id !== 'v-240' }]]) }),
    );
    expect(filtered.result.allowed).toEqual(['v-360', 'v-720']);
  });
});

describe('apply strategies through the reducer', () => {
  function pinnableState(): KernelState {
    const segments = Array.from({ length: 10 }, (_, seq) => ({
      seq,
      start: seq * 4,
      duration: 4,
      url: `https://cdn.example/hi/${seq}.m4s`,
    }));
    const hi: Rendition = { ...r720, segments };
    const base = initialState();
    return {
      ...base,
      lifecycle: { phase: 'ready' },
      presentation: {
        id: 'vod',
        isLive: false,
        duration: 40,
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
                renditions: [r240, hi],
              },
            ],
          },
        ],
        couplings: [],
      },
      buffers: new Map([
        ['sb:video', { codecs: 'avc1', ranges: [{ start: 0, end: 20 }], pendingAppends: 0 }],
      ]),
      scheduling: {
        ...base.scheduling,
        tokenSeq: 5,
        inflight: new Map([
          ['t5:v:5', { token: 't5:v:5', trackId: 'v', seq: 5, url: 'u', sbId: 'sb:video' }],
        ]),
      },
      playback: { currentTime: 4, buffered: [{ start: 0, end: 20 }], seeking: false },
    };
  }

  const reduce = createReducer();

  it("12. apply 'soon' emits abort, then an unbounded remove from the safePoint", () => {
    const [next, fx] = reduce(deepFreeze(structuredClone(pinnableState())), {
      type: 'PIN_RENDITION',
      renditionId: 'v-720',
      apply: 'soon',
    });
    // currentTime 4 + 1.5s lead = 5.5; the segment containing 5.5 is [4, 8),
    // so the next boundary is 8. No direct fetch: the flush's updateend
    // drives the scheduling loop, which refills init-first.
    expect(fx).toEqual([
      { kind: 'abort', token: 't5:v:5' },
      { kind: 'remove', sbId: 'sb:video', start: 8, end: Infinity },
    ]);
    expect(next.quality.pinned).toBe('v-720');
    expect(next.scheduling.inflight.size).toBe(0);
  });

  it("12c. the flush's updateend refills through the loop, init before media", () => {
    let state: KernelState = {
      ...structuredClone(pinnableState()),
      tracks: { active: new Map([['video', 'v']]), available: ['v'] },
    };
    [state] = reduce(deepFreeze(state), {
      type: 'PIN_RENDITION',
      renditionId: 'v-720',
      apply: 'now',
    });
    // The element reports the flushed ranges: only [0, 4) survives.
    const [next, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb:video',
      ranges: [{ start: 0, end: 4 }],
    });
    // The pinned rendition has no init in this fixture, so the loop goes
    // straight to the segment at the playhead, for the pinned rendition.
    const fetch = fx.find((e) => e.kind === 'fetch');
    expect(fetch).toMatchObject({ url: 'https://cdn.example/hi/1.m4s' });
    const request = [...next.scheduling.inflight.values()][0];
    expect(request).toMatchObject({ renditionId: 'v-720', seq: 1 });
  });

  it("12b. 'soon' with a buffer shorter than the lead degenerates to continue-at-end", () => {
    const state = pinnableState();
    const short: KernelState = {
      ...state,
      buffers: new Map([
        ['sb:video', { codecs: 'avc1', ranges: [{ start: 0, end: 5 }], pendingAppends: 0 }],
      ]),
    };
    const [, fx] = reduce(deepFreeze(structuredClone(short)), {
      type: 'PIN_RENDITION',
      renditionId: 'v-720',
      apply: 'soon',
    });
    expect(fx.filter((e) => e.kind === 'remove')).toHaveLength(0);
    expect(fx.filter((e) => e.kind === 'fetch')).toHaveLength(0);
  });

  it("13. apply 'next' emits no remove and no fetch", () => {
    const [next, fx] = reduce(deepFreeze(structuredClone(pinnableState())), {
      type: 'PIN_RENDITION',
      renditionId: 'v-720',
      apply: 'next',
    });
    expect(fx).toEqual([]);
    expect(next.quality.pinned).toBe('v-720');
    expect(next.quality.active).toBe('v-720');
  });

  it("'now' flushes from the playhead and nudges the element, fetching nothing itself", () => {
    const [, fx] = reduce(deepFreeze(structuredClone(pinnableState())), {
      type: 'PIN_RENDITION',
      renditionId: 'v-720',
      apply: 'now',
    });
    expect(fx.map((e) => e.kind)).toEqual(['abort', 'remove', 'seekElement']);
    expect(fx[1]).toMatchObject({ start: 4, end: Infinity });
  });
});

describe('active vs playing', () => {
  it('14. diverge after a next switch and converge as the buffer drains', () => {
    const arbiter = createArbiter();
    const log: Array<readonly [{ start: number; end: number }, string]> = [
      [{ start: 0, end: 8 }, 'v-240'],
      [{ start: 8, end: 16 }, 'v-720'],
    ];
    // active is already v-720 (being appended); the viewer still watches v-240.
    expect(arbiter.playingAt(log, 4)).toBe('v-240');
    expect(arbiter.playingAt(log, 7.9)).toBe('v-240');
    // The buffer drains past the switch point: they converge.
    expect(arbiter.playingAt(log, 9)).toBe('v-720');
    expect(arbiter.playingAt(log, 20)).toBeNull();
  });

  it('the reducer maintains and prunes the append log', () => {
    const reduce = createReducer();
    const base = initialState();
    const state: KernelState = {
      ...base,
      quality: { ...base.quality, appendLog: [[{ start: 0, end: 4 }, 'v-240']] },
      playback: { currentTime: 60, buffered: [], seeking: false },
      scheduling: {
        ...base.scheduling,
        inflight: new Map([
          [
            't1',
            {
              token: 't1',
              trackId: 'v',
              seq: 20,
              url: 'u',
              sbId: 'sb:video',
              renditionId: 'v-720',
              segmentStart: 80,
              segmentDuration: 4,
            },
          ],
        ]),
      },
    };
    const [next] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 20,
      bytes: new ArrayBuffer(8),
      rtt: 10,
      size: 8,
    });
    // The old entry ended at 4, far behind the watermark (60 - 30): pruned.
    expect(next.quality.appendLog).toEqual([[{ start: 80, end: 84 }, 'v-720']]);
  });

  it('an audio append never enters the append log', () => {
    // The log answers quality.playing with a video rendition id. An audio
    // segment arrives tagged with its track id, which no video rendition
    // has; logging it would make `playing` null while audio is buffered.
    const reduce = createReducer();
    const base = initialState();
    const state: KernelState = {
      ...base,
      quality: { ...base.quality, appendLog: [[{ start: 0, end: 4 }, 'v-240']] },
      scheduling: {
        ...base.scheduling,
        inflight: new Map([
          [
            'a1',
            {
              token: 'a1',
              trackId: 'aud-lo:English',
              seq: 0,
              url: 'u',
              sbId: 'sb:audio',
              renditionId: 'aud-lo:English',
              segmentStart: 0,
              segmentDuration: 4,
            },
          ],
        ]),
      },
    };
    const [next] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SEGMENT_LOADED',
      trackId: 'aud-lo:English',
      seq: 0,
      bytes: new ArrayBuffer(8),
      rtt: 10,
      size: 8,
    });
    expect(next.quality.appendLog).toEqual([[{ start: 0, end: 4 }, 'v-240']]);
  });
});

describe('memoization', () => {
  it('15. a thousand TIME_UPDATE-driven reads recompute the intersection at most once', () => {
    let filterCalls = 0;
    const spy: Constraint = {
      filter: (r) => {
        filterCalls += 1;
        return r.id !== 'v-240';
      },
    };
    const arbiter = createArbiter();
    const context = ctx({ constraints: constraints([['spy', spy]]) });
    let computed = 0;
    for (let i = 0; i < 1000; i += 1) {
      const outcome = arbiter.run(context, 7);
      if (outcome.computed) computed += 1;
      expect(outcome.result.selected).toBe('v-360');
    }
    expect(computed).toBe(1);
    expect(filterCalls).toBeLessThanOrEqual(RENDITIONS.length);

    // A version bump recomputes exactly once more.
    arbiter.run(context, 8);
    expect(filterCalls).toBeLessThanOrEqual(RENDITIONS.length * 2);
  });
});

describe('canSwitchTo default', () => {
  it('identical strings are seamless, a profile change is changeType, a family change reloads', () => {
    expect(canSwitchTo(r240, r360)).toBe('seamless');
    expect(canSwitchTo(r240, { ...r360, codecs: 'avc1.64001f' })).toBe('changeType');
    expect(canSwitchTo(r240, r720)).toBe('reload');
    expect(canSwitchTo(null, r720)).toBe('seamless');
  });
});
