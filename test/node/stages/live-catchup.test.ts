import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../../../src/kernel/reducer.js';
import type { CatchupApi, LiveCatchupOptions } from '../../../src/stages/live-catchup/index.js';
import liveCatchup, { catchupRate } from '../../../src/stages/live-catchup/index.js';
import type { LiveInfo } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';

const NARROW = { minRate: 0.96, maxRate: 1.04 };

describe('catchupRate, the dash.js curve', () => {
  it('is 1 on target', () => {
    expect(catchupRate(3, 3, NARROW)).toBe(1);
  });

  it('speeds up behind the target, towards the bound', () => {
    expect(catchupRate(3.2, 3, NARROW)).toBeCloseTo(1 - 0.04 + 0.08 / (1 + Math.exp(-1)));
    expect(catchupRate(6, 3, NARROW)).toBeCloseTo(1.04, 4);
  });

  it('slows down ahead of the target, towards the bound', () => {
    expect(catchupRate(2, 3, NARROW)).toBeCloseTo(0.96, 2);
    expect(catchupRate(2.9, 3, NARROW)).toBeLessThan(1);
  });
});

class FakeElement extends EventTarget {
  currentTime = 0;
  paused = false;
  seeking = false;
  playbackRate = 1;
  readyState = 4;
  bufferedEnd = 0;
  get buffered() {
    const end = this.bufferedEnd;
    return { length: 1, start: () => 0, end: () => end };
  }
  tick(): void {
    this.dispatchEvent(new Event('timeupdate'));
  }
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

function harness(options: LiveCatchupOptions = {}, info: LiveInfo = {}) {
  const element = new FakeElement();
  let state: KernelState = {
    ...initialState(),
    presentation: {
      id: 'p',
      isLive: true,
      periods: [],
      couplings: [],
      live: { updatePeriod: 1, lowLatency: true, ...info },
    },
    live: { span: { start: 0, end: 100 }, edge: 97 },
  };
  let api: CatchupApi | null = null;
  const emitted: Array<[string, unknown]> = [];
  const commands: Command[] = [];
  const traces: Array<(entry: unknown) => void> = [];
  liveCatchup(options).install({
    element: element as unknown as HTMLMediaElement,
    registerSink: () => undefined,
    registerParser: () => undefined,
    capabilities: () => [],
    registerTransform: () => undefined,
    registerNamespace: (_name, value) => {
      api = value as CatchupApi;
    },
    registerChooser: () => undefined,
    registerSwitchPolicy: () => undefined,
    registerTypeProbe: () => undefined,
    registerTimeProbe: () => undefined,
    registerChunkSplitter: () => undefined,
    getState: () => state,
    addRequestHook: () => () => undefined,
    addResponseHook: () => () => undefined,
    request: async () => new Response(),
    reduce: () => undefined,
    dispatch: (command) => commands.push(command),
    load: () => undefined,
    preload: async () => undefined,
    emit: (event, payload) => emitted.push([event, payload]),
    on: (event, fn) => {
      if (event === 'trace') traces.push(fn);
      return () => undefined;
    },
  });
  return {
    element,
    api: () => api as unknown as CatchupApi,
    emitted,
    commands,
    setWindow(end: number, edge: number) {
      state = { ...state, live: { span: { start: 0, end }, edge } };
    },
    setVod() {
      state = { ...state, presentation: null, live: null };
    },
  };
}

describe('the live-catchup stage', () => {
  let clock = 0;
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function useClock(): void {
    clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  }

  it('targets the manifest hold-back and leaves the rate at 1 on target', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 97;
    h.element.bufferedEnd = 100;
    h.element.tick();
    expect(h.api().target).toBe(3);
    expect(h.api().latency).toBeCloseTo(3);
    expect(h.element.playbackRate).toBe(1);
    expect(h.api().active).toBe(true);
  });

  it('speeds up behind the target within the default bounds, and reports the change', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 96;
    h.element.bufferedEnd = 99;
    h.element.tick();
    // One second behind, with dash.js's default bound of 1.5.
    expect(h.element.playbackRate).toBeCloseTo(1 - 0.5 + 1 / (1 + Math.exp(-5)));
    expect(h.emitted).toContainEqual(['catchup:rate', expect.objectContaining({ target: 3 })]);
  });

  it('measures to the moving edge between window updates', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 97;
    h.element.tick();
    clock += 500;
    expect(h.api().latency).toBeCloseTo(3.5);
    clock += 5000;
    expect(h.api().latency).toBeCloseTo(8.5);
  });

  it('a target option wins over the manifest', () => {
    useClock();
    const h = harness({ targetLatency: 5 });
    h.element.currentTime = 97;
    h.element.bufferedEnd = 100;
    h.element.tick();
    expect(h.api().target).toBe(5);
    expect(h.element.playbackRate).toBeLessThan(1);
    h.api().setTarget(null);
    expect(h.api().target).toBe(3);
  });

  it('seeks to the edge past the maximum drift, 12 s by default', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 86;
    h.element.tick();
    expect(h.commands).toEqual([]);
    h.element.currentTime = 84;
    h.element.tick();
    expect(h.commands).toEqual([{ type: 'SEEK_TO_LIVE_EDGE' }]);
    expect(h.emitted.map(([event]) => event)).toContain('catchup:seek');
  });

  it('after the viewer seeks back, holds the latency there', () => {
    useClock();
    const h = harness();
    h.element.fire('playing');
    h.element.currentTime = 40;
    h.element.fire('seeked');
    h.element.bufferedEnd = 60;
    h.element.tick();
    expect(h.api().target).toBeCloseTo(60);
    expect(h.api().active).toBe(false);
    expect(h.commands).toEqual([]);
    expect(h.element.playbackRate).toBe(1);
    // A seek back to the edge returns to the manifest's target.
    h.element.currentTime = 97;
    h.element.fire('seeked');
    expect(h.api().target).toBe(3);
    expect(h.api().active).toBe(true);
  });

  it('ignores the start-up seek', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 90;
    h.element.fire('seeked');
    expect(h.api().target).toBe(3);
  });

  it('keeps the rate at 1 after a stall until half the target is buffered', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 96;
    h.element.bufferedEnd = 96.5;
    h.element.fire('waiting');
    h.element.tick();
    expect(h.element.playbackRate).toBe(1);
    h.element.bufferedEnd = 98;
    h.element.tick();
    expect(h.element.playbackRate).toBeGreaterThan(1);
  });

  it('waits for future data before it sets a rate', () => {
    useClock();
    const h = harness();
    h.element.readyState = 2;
    h.element.currentTime = 96;
    h.element.tick();
    expect(h.element.playbackRate).toBe(1);
  });

  it("takes the manifest's rates and maximum latency where the options leave them", () => {
    useClock();
    const h = harness({}, { playbackRate: { min: 0.96, max: 1.04 }, maxLatency: 20 });
    // 13 s behind a 3 s target: past the default drift, inside Latency@max.
    h.element.currentTime = 84;
    h.element.tick();
    expect(h.commands).toEqual([]);
    expect(h.element.playbackRate).toBeCloseTo(1.04, 3);
    const fixed = harness({ maxRate: 1.02 }, { playbackRate: { min: 0.9, max: 1.1 } });
    fixed.element.currentTime = 90;
    fixed.element.tick();
    expect(fixed.element.playbackRate).toBeCloseTo(1.02, 3);
  });

  it('leaves a stream that is not low-latency alone, as dash.js does, unless enabled', () => {
    useClock();
    const plain = harness({}, { lowLatency: false });
    plain.element.currentTime = 80;
    plain.element.tick();
    expect(plain.element.playbackRate).toBe(1);
    expect(plain.commands).toEqual([]);
    expect(plain.api().active).toBe(false);
    const forced = harness({ enabled: true }, { lowLatency: false });
    forced.element.currentTime = 96;
    forced.element.tick();
    expect(forced.element.playbackRate).toBeGreaterThan(1);
  });

  it('does nothing for on-demand content and gives back its rate', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 96;
    h.element.tick();
    expect(h.element.playbackRate).toBeGreaterThan(1);
    h.setVod();
    h.element.tick();
    expect(h.element.playbackRate).toBe(1);
    expect(h.api().target).toBeNull();
  });
});

describe('before a user interaction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('changes no rate, and still seeks past the maximum drift', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => 1000);
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
    const h = harness();
    h.element.currentTime = 96;
    h.element.tick();
    expect(h.element.playbackRate).toBe(1);
    h.element.currentTime = 80;
    h.element.tick();
    expect(h.commands).toEqual([{ type: 'SEEK_TO_LIVE_EDGE' }]);
  });
});
