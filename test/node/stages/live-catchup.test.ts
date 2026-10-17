import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../../../src/kernel/reducer.js';
import type { CatchupApi, LiveCatchupOptions } from '../../../src/stages/live-catchup/index.js';
import liveCatchup, { catchupRate } from '../../../src/stages/live-catchup/index.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';

const SETTINGS = { minRate: 0.96, maxRate: 1.04, tolerance: 0.2, minBuffer: 0.5 };

describe('catchupRate', () => {
  it('is 1 within the tolerance', () => {
    expect(catchupRate(3.1, 3, 5, SETTINGS)).toBe(1);
    expect(catchupRate(2.85, 3, 5, SETTINGS)).toBe(1);
  });

  it('speeds up with the error behind the target, up to the bound', () => {
    expect(catchupRate(3.5, 3, 5, SETTINGS)).toBeCloseTo(1.02);
    expect(catchupRate(6, 3, 5, SETTINGS)).toBe(1.04);
  });

  it('slows down closer to the edge than the target, down to the bound', () => {
    expect(catchupRate(2.5, 3, 5, SETTINGS)).toBeCloseTo(0.98);
    expect(catchupRate(0.5, 3, 5, SETTINGS)).toBe(0.96);
  });

  it('never speeds up on a thin buffer', () => {
    expect(catchupRate(6, 3, 0.3, SETTINGS)).toBe(1);
    expect(catchupRate(0.5, 3, 0.3, SETTINGS)).toBe(0.96);
  });
});

class FakeElement extends EventTarget {
  currentTime = 0;
  paused = false;
  seeking = false;
  playbackRate = 1;
  bufferedEnd = 0;
  get buffered() {
    const end = this.bufferedEnd;
    return { length: 1, start: () => 0, end: () => end };
  }
  tick(): void {
    this.dispatchEvent(new Event('timeupdate'));
  }
}

function harness(options: LiveCatchupOptions = {}) {
  const element = new FakeElement();
  let state: KernelState = {
    ...initialState(),
    presentation: { id: 'p', isLive: true, periods: [], couplings: [], live: { updatePeriod: 1 } },
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
    getState: () => state,
    addRequestHook: () => () => undefined,
    addResponseHook: () => () => undefined,
    request: async () => new Response(),
    reduce: () => undefined,
    dispatch: (command) => commands.push(command),
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

  it('speeds up after drift and reports the change', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 96;
    h.element.bufferedEnd = 99;
    h.element.tick();
    expect(h.element.playbackRate).toBeCloseTo(1.04);
    expect(h.emitted).toContainEqual(['catchup:rate', expect.objectContaining({ target: 3 })]);
    // Back on target: the rate returns to 1.
    h.element.currentTime = 97;
    h.element.tick();
    expect(h.element.playbackRate).toBe(1);
  });

  it('measures to the moving edge between window updates, up to one refresh period', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 97;
    h.element.bufferedEnd = 100;
    h.element.tick();
    clock += 500;
    expect(h.api().latency).toBeCloseTo(3.5);
    clock += 5000;
    expect(h.api().latency).toBeCloseTo(4);
  });

  it('a target option wins over the manifest', () => {
    useClock();
    const h = harness({ targetLatency: 5 });
    h.element.currentTime = 97;
    h.element.bufferedEnd = 100;
    h.element.tick();
    expect(h.api().target).toBe(5);
    expect(h.element.playbackRate).toBeCloseTo(0.96);
    h.api().setTarget(null);
    expect(h.api().target).toBe(3);
  });

  it("leaves the page's own rate alone", () => {
    useClock();
    const h = harness();
    h.element.playbackRate = 1.5;
    h.element.currentTime = 90;
    h.element.bufferedEnd = 99;
    h.element.tick();
    expect(h.element.playbackRate).toBe(1.5);
    expect(h.commands).toEqual([]);
  });

  it('seeks to the edge past the maximum latency while holding the target', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 90;
    h.element.bufferedEnd = 99;
    h.element.tick();
    expect(h.commands).toEqual([{ type: 'SEEK_TO_LIVE_EDGE' }]);
    expect(h.emitted.map(([event]) => event)).toContain('catchup:seek');
  });

  it('stands down after the viewer seeks far behind, and returns at the target', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 40;
    h.element.dispatchEvent(new Event('seeked'));
    h.element.bufferedEnd = 60;
    h.element.tick();
    expect(h.api().active).toBe(false);
    expect(h.commands).toEqual([]);
    expect(h.element.playbackRate).toBe(1);
    // The viewer goes back to live.
    h.element.currentTime = 97;
    h.element.bufferedEnd = 100;
    h.element.tick();
    expect(h.api().active).toBe(true);
  });

  it('does nothing for on-demand content and gives back its rate', () => {
    useClock();
    const h = harness();
    h.element.currentTime = 96;
    h.element.bufferedEnd = 99;
    h.element.tick();
    expect(h.element.playbackRate).toBeCloseTo(1.04);
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

  it('changes no rate, and still seeks past the maximum latency', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => 1000);
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
    const h = harness();
    h.element.currentTime = 96;
    h.element.bufferedEnd = 99;
    h.element.tick();
    expect(h.element.playbackRate).toBe(1);
    h.element.currentTime = 90;
    h.element.tick();
    expect(h.commands).toEqual([{ type: 'SEEK_TO_LIVE_EDGE' }]);
  });
});
