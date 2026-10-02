import { afterEach, describe, expect, it, vi } from 'vitest';
import { arbitrate } from '../../../src/kernel/rendition-select.js';
import hdr, { type HdrApi, type HdrOptions } from '../../../src/stages/hdr/index.js';
import type { Presentation, Rendition } from '../../../src/types/ir.js';
import type { Command } from '../../../src/types/messages.js';
import type { StageContext } from '../../../src/types/stage.js';

const rung = (
  id: string,
  videoRange?: Rendition['videoRange'],
  codecs = 'hvc1.2.4.L120.B0',
): Rendition => ({
  id,
  bitrate: 1_000_000,
  codecs,
  mimeType: 'video/mp4',
  segments: [],
  width: 1920,
  height: 1080,
  ...(videoRange !== undefined ? { videoRange } : {}),
});

const presentation = (renditions: Rendition[]): Presentation => ({
  id: 'p',
  isLive: false,
  couplings: [],
  periods: [
    {
      id: 'p0',
      start: 0,
      tracks: [
        { id: 'v', contentType: 'video', mimeType: 'video/mp4', protection: null, renditions },
      ],
    },
  ],
});

/** A media query list for `dynamic-range`, answering `high`, `standard`, or neither. */
function stubDisplay(answer: 'high' | 'standard' | 'unknown') {
  const listeners: Array<() => void> = [];
  const state = { answer };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes(state.answer);
    },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener() {},
  }));
  return {
    change(next: 'high' | 'standard' | 'unknown') {
      state.answer = next;
      for (const fn of listeners) fn();
    },
  };
}

/** mediaCapabilities that knows the HDR fields (or not) and supports the listed codecs in HDR. */
function stubDecoder(knows: boolean, supported: readonly string[]) {
  vi.stubGlobal('navigator', {
    mediaCapabilities: {
      decodingInfo: async (config: { video: Record<string, unknown> }) => {
        const video = config.video;
        if (video.hdrMetadataType !== undefined) {
          if (knows) throw new TypeError('invalid HdrMetadataType');
          return { supported: true };
        }
        return { supported: supported.some((c) => String(video.contentType).includes(c)) };
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function install(renditions: Rendition[], options: HdrOptions = {}) {
  const dispatched: Command[] = [];
  const listeners: Array<() => void> = [];
  let api: HdrApi | null = null;
  let state = { presentation: presentation(renditions) };
  hdr(options).install({
    getState: () => state,
    dispatch: (cmd: Command) => dispatched.push(cmd),
    on: (_: string, fn: () => void) => {
      listeners.push(fn);
      return () => undefined;
    },
    registerNamespace: (_: string, value: HdrApi) => {
      api = value;
    },
  } as unknown as StageContext);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  for (const fn of listeners) fn();
  await settle();
  return {
    dispatched,
    api: () => api as unknown as HdrApi,
    settle,
    load(next: Rendition[]) {
      state = { presentation: presentation(next) };
      for (const fn of listeners) fn();
    },
  };
}

const constraints = (dispatched: Command[]) =>
  dispatched.map((c) =>
    c.type === 'CONSTRAIN' ? c.constraint : c.type === 'RELEASE_CONSTRAINT' ? 'release' : c.type,
  );

describe('the hdr stage', () => {
  it('does nothing for an SDR ladder', async () => {
    const h = await install([rung('a', 'SDR'), rung('b')]);
    expect(h.dispatched).toEqual([]);
    expect(h.api().source).toBeNull();
  });

  it('excludes HDR when nothing is known and SDR exists, and plays an HDR-only ladder', async () => {
    const h = await install([rung('sdr', 'SDR'), rung('pq', 'PQ')]);
    expect(constraints(h.dispatched)).toEqual([{ hdr: false }]);
    expect(h.api()).toMatchObject({ display: null, source: 'default', allowed: false });
    const only = await install([rung('pq', 'PQ'), rung('hlg', 'HLG')]);
    expect(only.dispatched).toEqual([]);
  });

  it('takes the option over the probes, a value or an async function', async () => {
    stubDisplay('standard');
    const yes = await install([rung('sdr', 'SDR'), rung('pq', 'PQ')], { supported: true });
    expect(yes.dispatched).toEqual([]);
    expect(yes.api()).toMatchObject({ source: 'option', allowed: true });
    const no = await install([rung('sdr', 'SDR'), rung('pq', 'PQ')], {
      supported: async () => false,
    });
    expect(constraints(no.dispatched)).toEqual([{ hdr: false }]);
  });

  it('excludes HDR on a display the browser knows is standard', async () => {
    stubDisplay('standard');
    const h = await install([rung('sdr', 'SDR'), rung('pq', 'PQ')]);
    expect(constraints(h.dispatched)).toEqual([{ hdr: false }]);
    expect(h.api()).toMatchObject({ display: false, source: 'probe' });
  });

  it('on an HDR display, excludes only the formats the decoder refuses', async () => {
    stubDisplay('high');
    stubDecoder(true, ['hvc1']);
    const h = await install([
      rung('sdr', 'SDR'),
      rung('hevc', 'PQ'),
      rung('av1', 'HLG', 'av01.0.09M.10'),
    ]);
    expect(constraints(h.dispatched)).toEqual([{ excludeIds: ['av1'] }]);
    expect(h.api().formats).toEqual({
      'hvc1.2.4.L120.B0|PQ': true,
      'av01.0.09M.10|HLG': false,
    });
  });

  it('does not trust a decoder that ignores the HDR fields', async () => {
    stubDisplay('unknown');
    stubDecoder(false, ['hvc1', 'av01']);
    const h = await install([rung('sdr', 'SDR'), rung('pq', 'PQ')]);
    expect(h.api()).toMatchObject({ formats: { 'hvc1.2.4.L120.B0|PQ': null }, source: 'default' });
    expect(constraints(h.dispatched)).toEqual([{ hdr: false }]);
  });

  it('asks again when the display changes, and releases for a new SDR source', async () => {
    const display = stubDisplay('standard');
    const h = await install([rung('sdr', 'SDR'), rung('pq', 'PQ')]);
    display.change('high');
    await h.settle();
    expect(constraints(h.dispatched)).toEqual([{ hdr: false }, 'release']);
    display.change('standard');
    await h.settle();
    h.load([rung('sdr', 'SDR')]);
    await h.settle();
    expect(constraints(h.dispatched)).toEqual([
      { hdr: false },
      'release',
      { hdr: false },
      'release',
    ]);
  });
});

describe('the hdr constraint in the selector', () => {
  const ctx = (renditions: Rendition[]) => ({
    renditions,
    constraints: new Map([['hdr', { hdr: false }]]),
    pinned: null,
    current: null,
    couplings: [],
    activeTracks: new Map(),
    telemetry: { throughputEwma: 0, throughputFastEwma: 0, bufferAhead: 0, droppedFrames: 0 },
  });

  it('removes PQ and HLG renditions and keeps SDR and unknown ones', () => {
    const outcome = arbitrate(
      ctx([rung('sdr', 'SDR'), rung('none'), rung('pq', 'PQ'), rung('hlg', 'HLG')]) as never,
    );
    expect(outcome.result.allowed).toEqual(['sdr', 'none']);
  });

  it('never empties a track: an HDR-only ladder drops it with a warning', () => {
    const outcome = arbitrate(ctx([rung('pq', 'PQ')]) as never);
    expect(outcome.result.allowed).toEqual(['pq']);
    expect(outcome.events).toContainEqual(
      expect.objectContaining({
        event: 'quality:constraints-unsatisfiable',
        payload: { dropped: ['hdr'] },
      }),
    );
  });
});
