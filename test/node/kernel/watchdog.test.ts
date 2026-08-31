import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackWatchdog } from '../../../src/kernel/watchdog.js';
import type { Fact } from '../../../src/types/messages.js';

interface FakeElement {
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  readyState: number;
  currentTime: number;
  ranges: Array<[number, number]>;
}

function element(overrides: Partial<FakeElement> = {}) {
  const el: FakeElement = {
    paused: false,
    seeking: false,
    ended: false,
    readyState: 4,
    currentTime: 4,
    ranges: [[0, 12]],
    ...overrides,
  };
  return Object.assign(el, {
    buffered: {
      get length() {
        return el.ranges.length;
      },
      start: (i: number) => (el.ranges[i] as [number, number])[0],
      end: (i: number) => (el.ranges[i] as [number, number])[1],
    },
  });
}

describe('playback watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a playing element that stops moving inside buffered data reports STALLED once per second', () => {
    const el = element();
    const facts: Fact[] = [];
    const stop = createPlaybackWatchdog(el, (f) => facts.push(f));
    vi.advanceTimersByTime(250);
    expect(facts).toEqual([]);
    // Four checks with no progress: one fact. Four more: another.
    vi.advanceTimersByTime(1000);
    expect(facts).toEqual([{ type: 'STALLED', at: 4 }]);
    vi.advanceTimersByTime(1000);
    expect(facts).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(5000);
    expect(facts).toHaveLength(2);
  });

  it('progress, pause, and seeking reset the streak', () => {
    const el = element();
    const facts: Fact[] = [];
    createPlaybackWatchdog(el, (f) => facts.push(f));
    vi.advanceTimersByTime(750);
    el.currentTime = 4.5;
    vi.advanceTimersByTime(750);
    expect(facts).toEqual([]);
    el.paused = true;
    vi.advanceTimersByTime(3000);
    expect(facts).toEqual([]);
    el.paused = false;
    el.seeking = true;
    vi.advanceTimersByTime(3000);
    expect(facts).toEqual([]);
  });

  it('underflow with no data in reach is not a stall', () => {
    // The playhead sits at the end of the buffer: the scheduler is fetching,
    // and a fact here would only add noise to the trace.
    const el = element({ currentTime: 12, ranges: [[0, 12]] });
    const facts: Fact[] = [];
    createPlaybackWatchdog(el, (f) => facts.push(f));
    vi.advanceTimersByTime(3000);
    expect(facts).toEqual([]);
    // A range just ahead, though, is a hole the recovery stage can jump.
    el.ranges = [
      [0, 12],
      [12.3, 20],
    ];
    vi.advanceTimersByTime(1000);
    expect(facts).toEqual([{ type: 'STALLED', at: 12 }]);
  });
});
