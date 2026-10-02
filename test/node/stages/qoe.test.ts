import { afterEach, describe, expect, it, vi } from 'vitest';
import qoe, { type QoeMetrics } from '../../../src/stages/qoe/index.js';
import type { StageContext } from '../../../src/types/stage.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function harness() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock * 1000);
  const element = Object.assign(new EventTarget(), {
    paused: true,
    seeking: false,
    currentTime: 0,
  });
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const events: Array<QoeMetrics & { reason: string }> = [];
  let active: string | null = null;
  let api: QoeMetrics | null = null;
  qoe().install({
    element,
    getState: () => ({ quality: { active } }),
    emit: (_: string, payload: QoeMetrics & { reason: string }) => events.push(payload),
    on: (event: string, fn: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => undefined;
    },
    registerNamespace: (_: string, value: QoeMetrics) => {
      api = value;
    },
  } as unknown as StageContext);
  const fire = (name: string) => element.dispatchEvent(new Event(name));
  const trace = (type: string) => {
    for (const fn of listeners.get('trace') ?? []) fn({ msg: { type } });
  };
  return {
    element,
    events,
    api: () => api as unknown as QoeMetrics,
    at(seconds: number) {
      clock = seconds;
    },
    fire,
    load() {
      trace('LOAD');
    },
    switchTo(id: string) {
      active = id;
      trace('SEGMENT_LOADED');
    },
    stalled() {
      for (const fn of listeners.get('playback:stalled') ?? []) fn({});
    },
    play() {
      element.paused = false;
      fire('play');
    },
  };
}

describe('the qoe stage', () => {
  it('measures startup from the later of load and play to the first frame', () => {
    const h = harness();
    h.at(10);
    h.load();
    h.at(12);
    h.play();
    h.at(12.8);
    h.fire('playing');
    expect(h.api().startupTime).toBeCloseTo(0.8, 6);
    expect(h.events.map((e) => e.reason)).toEqual(['startup']);
  });

  it('counts rebuffers after startup, not seeks, and ends an unannounced stall when time moves', () => {
    const h = harness();
    h.play();
    h.load();
    h.at(1);
    h.fire('playing');
    h.at(5);
    h.fire('waiting');
    h.at(6.5);
    expect(h.api().rebufferDuration).toBeCloseTo(1.5, 6);
    h.fire('playing');
    // A seek waits too, but is not rebuffering.
    h.element.seeking = true;
    h.fire('waiting');
    h.element.seeking = false;
    // The watchdog finds a stall the browser never announced.
    h.at(10);
    h.element.currentTime = 20;
    h.stalled();
    h.at(12);
    h.element.currentTime = 20.5;
    h.fire('timeupdate');
    expect(h.api()).toMatchObject({ rebuffers: 2, rebufferDuration: 3.5 });
    expect(h.events.map((e) => e.reason)).toEqual(['startup', 'rebuffer', 'rebuffer']);
  });

  it('counts video switches after the first selection, and starts over on a new load', () => {
    const h = harness();
    h.load();
    h.switchTo('v1');
    h.switchTo('v2');
    h.switchTo('v3');
    expect(h.api().switches).toBe(2);
    h.load();
    expect(h.api()).toMatchObject({ startupTime: null, rebuffers: 0, switches: 0 });
  });
});
