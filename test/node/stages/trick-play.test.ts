import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fragmentSamples } from '../../../src/containers/mp4-box/index.js';
import { initialState } from '../../../src/kernel/reducer.js';
import type { TrickApi } from '../../../src/stages/trick-play/index.js';
import trickPlay from '../../../src/stages/trick-play/index.js';
import type { Presentation, Rendition, Track } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

const SEGMENTS = join(import.meta.dirname, '../../fixtures/segments');

function rendition(id: string): Rendition {
  return { id, bitrate: 1, codecs: 'avc1.64001e', mimeType: 'video/mp4', segments: [] };
}

function track(id: string, role?: string): Track {
  return {
    id,
    contentType: 'video',
    mimeType: 'video/mp4',
    protection: null,
    renditions: [rendition(`${id}-r`)],
    ...(role !== undefined ? { role } : {}),
  };
}

function presentation(withTrick: boolean): Presentation {
  return {
    id: 'p',
    isLive: false,
    couplings: [],
    periods: [
      {
        id: 'p0',
        start: 0,
        tracks: [track('v'), ...(withTrick ? [track('v-trick', 'trick')] : [])],
      },
    ],
  };
}

/** A media element with the members the stage touches. */
function fakeElement() {
  const listeners = new Map<string, () => void>();
  return {
    muted: false,
    paused: false,
    playbackRate: 1,
    currentTime: 30,
    seekable: { length: 1, start: () => 0, end: () => 600 },
    play: vi.fn(async () => undefined),
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true;
    }),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: string) => listeners.get(type)?.(),
  };
}

function install(options: { withTrick?: boolean } = {}) {
  const element = fakeElement();
  let state: KernelState = {
    ...initialState(),
    presentation: presentation(options.withTrick ?? true),
    tracks: { active: new Map([['video', 'v']]), available: ['v', 'v-trick'] },
  };
  const dispatched: Command[] = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  let api: TrickApi | null = null;
  let transform: TransformStep | null = null;
  const ctx = {
    element,
    getState: () => state,
    reduce: () => undefined,
    registerTransform: (step: TransformStep) => {
      transform = step;
    },
    registerNamespace: (_name: string, value: object) => {
      api = value as TrickApi;
    },
    dispatch: (cmd: Command) => dispatched.push(cmd),
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
  } as unknown as StageContext;
  const teardown = trickPlay().install(ctx) as () => void;
  return {
    api: api as unknown as TrickApi,
    transform: transform as unknown as TransformStep,
    element,
    dispatched,
    events,
    teardown,
    setState(update: Partial<KernelState>) {
      state = { ...state, ...update };
    },
  };
}

describe('fitting trick fragments', () => {
  const init = new Uint8Array(readFileSync(join(SEGMENTS, 'apple-iframe-init.mp4')));
  const range = new Uint8Array(readFileSync(join(SEGMENTS, 'apple-iframe-range.mp4')));
  const meta = (trackId: string, isInit: boolean): SegmentMeta => ({
    trackId,
    renditionId: `${trackId}-r`,
    contentType: 'video',
    seq: isInit ? -1 : 0,
    start: 0,
    duration: 2,
    isInit,
  });

  it('rebuilds a trick segment once its init named the clock', async () => {
    const { transform } = install();
    expect(await transform.transform(init, meta('v-trick', true))).toBe(init);
    const fitted = await transform.transform(range, meta('v-trick', false));
    expect(fitted).not.toBe(range);
    expect(fragmentSamples(fitted)[0]?.samples).toHaveLength(1);
  });

  it('leaves every other track alone', async () => {
    const { transform } = install();
    await transform.transform(init, meta('v', true));
    expect(await transform.transform(range, meta('v', false))).toBe(range);
  });
});

describe('engine.trick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forward past 2x plays the trick track at the rate, muted, and back at 1', () => {
    const { api, element, dispatched, events } = install();
    const goal = initialState().scheduling.bufferGoal;
    expect(api.available).toBe(true);
    api.setRate(8);
    expect(dispatched).toEqual([
      { type: 'SELECT_TRACK', trackId: 'v-trick', apply: 'now' },
      { type: 'SET_BUFFER_GOAL', seconds: goal * 8 },
    ]);
    expect(element).toMatchObject({ playbackRate: 8, muted: true });
    expect(api.rate).toBe(8);
    expect(events).toEqual([{ event: 'trick:started', payload: { rate: 8 } }]);

    dispatched.length = 0;
    api.setRate(1);
    expect(dispatched).toEqual([
      { type: 'SELECT_TRACK', trackId: 'v', apply: 'now' },
      { type: 'SET_BUFFER_GOAL', seconds: goal },
    ]);
    expect(element).toMatchObject({ playbackRate: 1, muted: false });
    expect(api.rate).toBe(1);
    expect(events[1]).toEqual({ event: 'trick:stopped', payload: { rate: 8, reason: 'rate' } });
  });

  it('a rate from -2 to 2 other than 1 is playback speed, not a scan, and throws', () => {
    const { api, element, dispatched } = install();
    for (const rate of [2, 1.5, 0.5, -1, -2]) {
      expect(() => api.setRate(rate)).toThrow(RangeError);
    }
    expect(dispatched).toEqual([]);
    expect(element.playbackRate).toBe(1);
  });

  it('setRate(1) leaves a speed the app set on the element alone', () => {
    const { api, element } = install();
    element.playbackRate = 1.5;
    api.setRate(1);
    expect(element.playbackRate).toBe(1.5);
  });

  it('rewind pauses and steps back until the start', () => {
    const { api, element, events } = install();
    element.currentTime = 3;
    api.setRate(-4);
    expect(element.pause).toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(element.currentTime).toBe(2);
    vi.advanceTimersByTime(750);
    expect(element.currentTime).toBe(0);
    expect(api.rate).toBe(1);
    expect(events.at(-1)).toEqual({
      event: 'trick:stopped',
      payload: { rate: -4, reason: 'start' },
    });
  });

  it('forward scanning stops at the live edge', () => {
    const { api, element, events, setState } = install();
    setState({ live: { span: { start: 0, end: 100 }, edge: 97 } });
    api.setRate(8);
    element.currentTime = 95.5;
    element.fire('timeupdate');
    expect(api.rate).toBe(1);
    expect(events.at(-1)).toEqual({ event: 'trick:stopped', payload: { rate: 8, reason: 'edge' } });
  });

  it('a new source ends scanning without switching back', () => {
    const { api, dispatched, setState } = install();
    api.setRate(8);
    dispatched.length = 0;
    setState({ 'trick-play': { loads: 1 } });
    expect(api.rate).toBe(1);
    expect(dispatched).toEqual([]);
  });

  it('without an I-frame track there is nothing to scan with', () => {
    const { api, element, dispatched } = install({ withTrick: false });
    expect(api.available).toBe(false);
    expect(() => api.setRate(8)).toThrow('no I-frame track');
    expect(() => api.setRate(-8)).toThrow('no I-frame track');
    expect(dispatched).toEqual([]);
    expect(element).toMatchObject({ playbackRate: 1, muted: false });
  });

  it('rejects a rate of 0 or not a number', () => {
    const { api } = install();
    expect(() => api.setRate(0)).toThrow(RangeError);
    expect(() => api.setRate(Number.NaN)).toThrow(RangeError);
  });

  it('detach stops the rewind timer', () => {
    const { api, element, teardown } = install();
    api.setRate(-4);
    teardown();
    const at = element.currentTime;
    vi.advanceTimersByTime(1000);
    expect(element.currentTime).toBe(at);
  });
});
