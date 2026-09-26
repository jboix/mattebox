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
    seeking: false,
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

function install(
  options: {
    withTrick?: boolean;
    presentation?: Presentation;
    request?: (url: string, init: { headers?: Record<string, string> }) => Promise<Response>;
  } = {},
) {
  const element = fakeElement();
  let state: KernelState = {
    ...initialState(),
    presentation: options.presentation ?? presentation(options.withTrick ?? true),
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
    request: options.request ?? (async () => new Response(null, { status: 404 })),
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

  it('scrubbing shows key frames on the trick track, and ends where the pointer let go', () => {
    const { api, element, dispatched, events } = install();
    const goal = initialState().scheduling.bufferGoal;
    api.scrubStart();
    expect(api.scrubbing).toBe(true);
    expect(dispatched).toEqual([
      { type: 'SELECT_TRACK', trackId: 'v-trick', apply: 'now' },
      { type: 'SET_BUFFER_GOAL', seconds: Math.min(goal, 4) },
    ]);
    expect(element.pause).toHaveBeenCalled();
    api.scrubTo(80);
    expect(element.currentTime).toBe(80);

    dispatched.length = 0;
    api.scrubEnd(42);
    // The kernel learns the time before the switch back plans around it.
    expect(dispatched).toEqual([
      { type: 'SEEK', to: 42 },
      { type: 'SELECT_TRACK', trackId: 'v', apply: 'now' },
      { type: 'SET_BUFFER_GOAL', seconds: goal },
    ]);
    expect(element.play).toHaveBeenCalled();
    expect(api.scrubbing).toBe(false);
    expect(events).toEqual([
      { event: 'trick:scrub-started', payload: {} },
      { event: 'trick:scrub-ended', payload: { time: 42 } },
    ]);
  });

  it('every scrub position seeks the element; the browser drops seeks it did not finish', () => {
    const { api, element } = install();
    api.scrubStart();
    element.seeking = true;
    api.scrubTo(10);
    api.scrubTo(20);
    expect(element.currentTime).toBe(20);
  });

  it('scrub positions stay inside the seekable range', () => {
    const { api, element } = install();
    api.scrubStart();
    api.scrubTo(-5);
    expect(element.currentTime).toBe(0);
    api.scrubTo(9999);
    expect(element.currentTime).toBe(600);
  });

  it('a scrub started during a scan takes over its saved state', () => {
    const { api, dispatched, events } = install();
    api.setRate(8);
    dispatched.length = 0;
    api.scrubStart();
    expect(dispatched.filter((c) => c.type === 'SELECT_TRACK')).toEqual([]);
    expect(api.rate).toBe(1);
    expect(events).toContainEqual({
      event: 'trick:stopped',
      payload: { rate: 8, reason: 'scrub' },
    });
    api.scrubEnd(50);
    expect(dispatched).toContainEqual({ type: 'SELECT_TRACK', trackId: 'v', apply: 'now' });
  });

  it('without an I-frame track there is nothing to scrub with', () => {
    const { api } = install({ withTrick: false });
    expect(() => api.scrubStart()).toThrow('no I-frame track');
  });
});

describe('frameAt', () => {
  const init = new Uint8Array(readFileSync(join(SEGMENTS, 'apple-iframe-init.mp4')));
  const range = new Uint8Array(readFileSync(join(SEGMENTS, 'apple-iframe-range.mp4')));
  // Response bodies: copies, so a consumed body never touches the fixtures.
  const init0 = () => init.slice();
  const range0 = () => range.slice();

  /** A trick rendition with an init and one 2 s segment, as a resolved I-frame playlist gives. */
  function resolved(): Presentation {
    const base = presentation(true);
    const period = base.periods[0] as Presentation['periods'][number];
    const tracks = period.tracks.map((t) =>
      t.role !== 'trick'
        ? t
        : {
            ...t,
            renditions: t.renditions.map((r) => ({
              ...r,
              init: { url: 'https://cdn.example/main.mp4', byteRange: { start: 0, end: 719 } },
              segments: [
                {
                  seq: 1,
                  start: 0,
                  duration: 2,
                  url: 'https://cdn.example/main.mp4',
                  byteRange: { start: 720, end: 720 + range.byteLength - 1 },
                },
              ],
            })),
          },
    );
    return { ...base, periods: [{ ...period, tracks }] };
  }

  /** A WebCodecs stand-in that records what it decodes and outputs one frame. */
  function stubWebCodecs() {
    const decoded: Array<{ codec: string; description: number; bytes: number }> = [];
    let codec = '';
    let description = 0;
    class FakeDecoder {
      state = 'unconfigured';
      private readonly output: (frame: unknown) => void;
      constructor(init: { output: (frame: unknown) => void }) {
        this.output = init.output;
      }
      static async isConfigSupported() {
        return { supported: true };
      }
      configure(config: { codec: string; description: Uint8Array }) {
        codec = config.codec;
        description = config.description.byteLength;
        this.state = 'configured';
      }
      decode(chunk: { byteLength: number }) {
        decoded.push({ codec, description, bytes: chunk.byteLength });
        this.output({ close: () => undefined });
      }
      async flush() {}
      close() {
        this.state = 'closed';
      }
    }
    class FakeChunk {
      readonly byteLength: number;
      constructor(init: { data: Uint8Array }) {
        this.byteLength = init.data.byteLength;
      }
    }
    vi.stubGlobal('VideoDecoder', FakeDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeChunk);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (_frame: unknown, options: { resizeWidth: number }) => ({
        width: options.resizeWidth,
        close: vi.fn(),
      })),
    );
    return decoded;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null without WebCodecs', async () => {
    const { api } = install();
    expect(await api.frameAt(1)).toBeNull();
  });

  it('asks the adapters to resolve the I-frame track once, and answers null until then', async () => {
    stubWebCodecs();
    const { api, dispatched } = install();
    expect(await api.frameAt(1)).toBeNull();
    expect(await api.frameAt(2)).toBeNull();
    expect(dispatched).toEqual([{ type: 'RESOLVE_RENDITION', renditionId: 'v-trick-r' }]);
  });

  it('decodes the first key frame of the segment under the time, and caches it', async () => {
    const decoded = stubWebCodecs();
    const requests: string[] = [];
    const harness = install({
      presentation: resolved(),
      request: async (_url, init) => {
        const header = init.headers?.Range ?? '';
        requests.push(header);
        return new Response(header === 'bytes=0-719' ? init0() : range0(), { status: 206 });
      },
    });
    const bitmap = await harness.api.frameAt(1, { width: 160 });
    expect(bitmap).toMatchObject({ width: 160 });
    // The avcC of the init and the 13751-byte IDR sample of the range.
    expect(decoded).toEqual([
      { codec: 'avc1.64001e', description: expect.any(Number), bytes: 13751 },
    ]);
    expect(requests.sort()).toEqual(['bytes=0-719', `bytes=720-${720 + range.byteLength - 1}`]);
    expect(await harness.api.frameAt(1.5, { width: 160 })).toBe(bitmap);
    expect(requests).toHaveLength(2);
  });

  it('decodes one frame at a time and keeps only the newest waiting call', async () => {
    const decoded = stubWebCodecs();
    const harness = install({
      presentation: resolved(),
      request: async (_url, init) =>
        new Response(init.headers?.Range === 'bytes=0-719' ? init0() : range0(), { status: 206 }),
    });
    const first = harness.api.frameAt(0.5, { width: 100 });
    const replaced = harness.api.frameAt(1, { width: 200 });
    const newest = harness.api.frameAt(1.5, { width: 300 });
    expect(await replaced).toBeNull();
    expect(await first).toMatchObject({ width: 100 });
    expect(await newest).toMatchObject({ width: 300 });
    expect(decoded).toHaveLength(2);
  });

  it('is null on encrypted content', async () => {
    stubWebCodecs();
    const encrypted = resolved();
    const period = encrypted.periods[0] as Presentation['periods'][number];
    const locked: Presentation = {
      ...encrypted,
      periods: [
        {
          ...period,
          tracks: period.tracks.map((t) =>
            t.role === 'trick' ? { ...t, protection: { schemes: [] } } : t,
          ),
        },
      ],
    };
    const harness = install({ presentation: locked, request: async () => new Response(range0()) });
    expect(await harness.api.frameAt(1)).toBeNull();
  });
});
