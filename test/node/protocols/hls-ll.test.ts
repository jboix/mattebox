import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import { parseMediaPlaylist } from '../../../src/protocols/hls-cmaf/parse.js';
import hlsLive from '../../../src/protocols/hls-live/index.js';
import hlsLl from '../../../src/protocols/hls-ll/index.js';
import type { LowLatencyPlaylist } from '../../../src/protocols/hls-ll/parse.js';
import {
  nextReload,
  parseLowLatency,
  withDirectives,
} from '../../../src/protocols/hls-ll/parse.js';
import type { Segment } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect } from '../../../src/types/messages.js';
import type { Stage } from '../../../src/types/stage.js';

const BASE = 'https://ll.example/v/';
const URL = `${BASE}media.m3u8`;

interface LlOptions {
  /** Media sequence number of the first listed segment. */
  readonly msn: number;
  /** Full segments listed. */
  readonly segments: number;
  /** How many of the newest full segments list their parts. */
  readonly withParts?: number;
  /** Parts of the segment being written, after the last full one. */
  readonly trailing?: number;
  readonly hint?: boolean;
  readonly control?: string | null;
  readonly skipped?: number;
  readonly reports?: readonly string[];
  readonly independent?: boolean;
}

/** An LL-HLS playlist of 4 s segments cut into four 1 s parts, the first independent. */
function llPlaylist(o: LlOptions): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:9', '#EXT-X-TARGETDURATION:4'];
  const control =
    o.control === undefined
      ? 'CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=3.0,HOLD-BACK=12.0,CAN-SKIP-UNTIL=24.0'
      : o.control;
  if (control !== null) lines.push(`#EXT-X-SERVER-CONTROL:${control}`);
  lines.push('#EXT-X-PART-INF:PART-TARGET=1.0', `#EXT-X-MEDIA-SEQUENCE:${o.msn}`);
  lines.push('#EXT-X-MAP:URI="init.mp4"');
  const skipped = o.skipped ?? 0;
  if (skipped > 0) lines.push(`#EXT-X-SKIP:SKIPPED-SEGMENTS=${skipped}`);
  const independent = o.independent ?? true;
  const parts = (seq: number, count: number) => {
    for (let p = 0; p < count; p += 1) {
      const flag = p === 0 && independent ? ',INDEPENDENT=YES' : '';
      lines.push(`#EXT-X-PART:DURATION=1.0,URI="part-${seq}.${p}.mp4"${flag}`);
    }
  };
  const first = o.msn + skipped;
  for (let i = 0; i < o.segments; i += 1) {
    const seq = first + i;
    if (o.segments - i <= (o.withParts ?? 0)) parts(seq, 4);
    lines.push('#EXTINF:4.0,', `seg-${seq}.mp4`);
  }
  const writing = first + o.segments;
  parts(writing, o.trailing ?? 0);
  if (o.hint ?? true) {
    lines.push(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-${writing}.${o.trailing ?? 0}.mp4"`);
  }
  for (const report of o.reports ?? []) lines.push(report);
  return lines.join('\n');
}

function ll(text: string, previous: readonly Segment[] = []): LowLatencyPlaylist {
  const result = parseLowLatency(text, URL, previous);
  if (result.playlist === null) throw new Error(result.error.code);
  return result.playlist as LowLatencyPlaylist;
}

describe('the low-latency parser', () => {
  it('plays the newest segments from their parts and the one being written', () => {
    const playlist = ll(llPlaylist({ msn: 10, segments: 3, withParts: 1, trailing: 2 }));
    const seqs = playlist.segments.map((s) => s.seq);
    // Two whole segments, the third as its four parts, two parts of the
    // fourth, and the hint for the fourth's third part.
    expect(seqs).toEqual([10, 11, 12, 12.001, 12.002, 12.003, 13, 13.001, 13.002]);
    const parts = playlist.segments.slice(2);
    expect(parts.map((s) => s.start)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(parts.map((s) => s.url)).toEqual([
      `${BASE}part-12.0.mp4`,
      `${BASE}part-12.1.mp4`,
      `${BASE}part-12.2.mp4`,
      `${BASE}part-12.3.mp4`,
      `${BASE}part-13.0.mp4`,
      `${BASE}part-13.1.mp4`,
      `${BASE}part-13.2.mp4`,
    ]);
    expect(parts.map((s) => s.independent)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(parts.at(-1)?.preload).toBe(true);
    expect(parts.slice(0, -1).every((s) => s.preload === undefined)).toBe(true);
  });

  it('holds back PART-HOLD-BACK where the parts play, HOLD-BACK where they do not', () => {
    expect(ll(llPlaylist({ msn: 10, segments: 3, trailing: 1 })).holdBack).toBe(3);
    const noParts = llPlaylist({ msn: 10, segments: 3, hint: false }).replace(
      '#EXT-X-PART-INF:PART-TARGET=1.0\n',
      '',
    );
    expect(ll(noParts).holdBack).toBe(12);
    // Without PART-HOLD-BACK, three part targets.
    const bare = llPlaylist({ msn: 10, segments: 3, trailing: 1, control: 'CAN-BLOCK-RELOAD=YES' });
    expect(ll(bare).holdBack).toBe(3);
  });

  it('the base parser reads HOLD-BACK and ignores the parts', () => {
    const result = parseMediaPlaylist(llPlaylist({ msn: 10, segments: 3, trailing: 2 }), URL);
    expect(result.playlist?.holdBack).toBe(12);
    expect(result.playlist?.segments.map((s) => s.seq)).toEqual([10, 11, 12]);
  });

  it('a part BYTERANGE without an offset continues the previous part of the same file', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=3.0',
      '#EXT-X-PART-INF:PART-TARGET=1.0',
      '#EXT-X-MEDIA-SEQUENCE:5',
      '#EXTINF:4.0,',
      'seg-5.mp4',
      '#EXT-X-PART:DURATION=1.0,URI="seg-6.mp4",BYTERANGE="100@0",INDEPENDENT=YES',
      '#EXT-X-PART:DURATION=1.0,URI="seg-6.mp4",BYTERANGE="200"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg-6.mp4",BYTERANGE-START=300',
    ].join('\n');
    const segments = ll(text).segments;
    expect(segments[1]?.byteRange).toEqual({ start: 0, end: 99 });
    expect(segments[2]?.byteRange).toEqual({ start: 100, end: 299 });
    // A hint with a start and no length asks for the rest of the file.
    expect(segments[3]?.byteRange).toEqual({ start: 300, end: Infinity });
  });

  it('a segment with a gap part, or an AES-128 key, plays whole', () => {
    const gap = llPlaylist({ msn: 10, segments: 2, withParts: 1, hint: false }).replace(
      'URI="part-11.2.mp4"',
      'URI="part-11.2.mp4",GAP=YES',
    );
    expect(ll(gap).segments.map((s) => s.seq)).toEqual([10, 11]);
    const keyed = llPlaylist({ msn: 10, segments: 2, withParts: 1, trailing: 1 }).replace(
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    );
    expect(ll(keyed).segments.map((s) => s.seq)).toEqual([10, 11]);
  });

  it('parts of a playlist that marks none independent leave the flag out', () => {
    const playlist = ll(llPlaylist({ msn: 1, segments: 1, trailing: 2, independent: false }));
    expect(playlist.segments.every((s) => s.independent === undefined)).toBe(true);
  });

  it('the next reload waits for the next part, with a delta update when allowed', () => {
    const playlist = ll(llPlaylist({ msn: 10, segments: 3, trailing: 2 }));
    expect(playlist.next).toEqual({ msn: 13, part: 2 });
    expect(nextReload(URL, playlist, true)).toBe(`${URL}?_HLS_msn=13&_HLS_part=2&_HLS_skip=YES`);
    expect(nextReload(URL, playlist, false)).toBe(`${URL}?_HLS_msn=13&_HLS_part=2`);
    // A finished segment and no parts yet: part 0 of the next one.
    expect(ll(llPlaylist({ msn: 10, segments: 3, hint: false })).next).toEqual({
      msn: 13,
      part: 0,
    });
    // A server that does not block: the loop keeps its cadence.
    const polled = ll(llPlaylist({ msn: 10, segments: 3, control: 'PART-HOLD-BACK=3.0' }));
    expect(nextReload(URL, polled, true)).toBeNull();
    expect(withDirectives(`${URL}?token=a`, { msn: 4 }, false)).toBe(`${URL}?token=a&_HLS_msn=4`);
  });

  it('rendition reports become URLs that load the other playlists at their last part', () => {
    const playlist = ll(
      llPlaylist({
        msn: 10,
        segments: 3,
        trailing: 1,
        reports: ['#EXT-X-RENDITION-REPORT:URI="../hi/media.m3u8",LAST-MSN=13,LAST-PART=0'],
      }),
    );
    expect(playlist.reports).toEqual({
      'https://ll.example/hi/media.m3u8':
        'https://ll.example/hi/media.m3u8?_HLS_msn=13&_HLS_part=0',
    });
  });

  it('a delta update takes its skipped segments from the previous window', () => {
    const full = ll(llPlaylist({ msn: 10, segments: 6, trailing: 1 }));
    // The previous window sits at presentation time 100.
    const previous = full.segments.map((s) => ({ ...s, start: s.start + 100 }));
    const delta = ll(llPlaylist({ msn: 11, segments: 3, skipped: 3, trailing: 2 }), previous);
    expect(delta.skipped).toBe(0);
    expect(delta.segments.map((s) => s.seq)).toEqual([11, 12, 13, 14, 15, 16, 17, 17.001, 17.002]);
    // Segment 14 continues where segment 13 of the previous window ended.
    expect(delta.segments.find((s) => s.seq === 14)?.start).toBe(116);
  });

  it('a delta update the previous window cannot fill keeps its skip count', () => {
    const delta = parseLowLatency(llPlaylist({ msn: 40, segments: 3, skipped: 3 }), URL, []);
    expect(delta.playlist?.skipped).toBe(3);
  });
});

function compose(...factories: Array<() => Stage>) {
  const slices: Array<readonly [string, SliceReducer]> = [];
  for (const factory of factories) {
    factory().install({
      element: new EventTarget() as unknown as HTMLMediaElement,
      registerSink: () => undefined,
      registerParser: () => undefined,
      capabilities: () => [],
      registerTransform: () => undefined,
      registerNamespace: () => undefined,
      registerChooser: () => undefined,
      registerSwitchPolicy: () => undefined,
      registerTypeProbe: () => undefined,
      registerTimeProbe: () => undefined,
      getState: () => initialState(),
      addRequestHook: () => () => undefined,
      addResponseHook: () => () => undefined,
      request: async () => new Response(),
      reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
      dispatch: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
    });
  }
  return createReducer(slices);
}

type Reduce = ReturnType<typeof createReducer>;

/** Follows zero-delay loop-back schedule effects the way the runner would. */
function settle(reduce: Reduce, state: KernelState, effects: readonly Effect[]) {
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

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function answer(reduce: Reduce, state: KernelState, trackId: string, text: string) {
  return settle(
    reduce,
    ...reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId,
      seq: 0,
      bytes: bytes(text),
      rtt: 5,
      size: 500,
    }),
  );
}

function fetches(effects: readonly Effect[]) {
  return effects.filter((e): e is Extract<Effect, { kind: 'fetch' }> => e.kind === 'fetch');
}

function reloadTicks(effects: readonly Effect[]) {
  return effects.filter((e) => e.kind === 'schedule' && e.token === 'hls-live:reload');
}

function boot(reduce: Reduce, text: string) {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: URL });
  return answer(reduce, state, 'manifest', text);
}

const REFRESH = 'hls:live:refresh:r-0';

describe('hls-ll', () => {
  const reduce = compose(hlsLl);

  it('provides hls-cmaf and hls-live, so it replaces them', () => {
    expect(hlsLl().provides).toEqual(expect.arrayContaining(['hls-cmaf', 'hls-live', 'hls-ll']));
  });

  it('the first playlist already plays from its parts and starts at PART-HOLD-BACK', () => {
    const { state, effects } = boot(reduce, llPlaylist({ msn: 10, segments: 3, trailing: 2 }));
    // The window ends at the last part, not at the hint: 12 + 2 parts.
    expect(state.live).toEqual({ span: { start: 0, end: 14 }, edge: 11 });
    // The loop asks the server at once whether it blocks.
    expect(reloadTicks(effects)).toEqual([expect.objectContaining({ delayMs: 500 })]);
  });

  it('a blocking server: each answer asks for the next part at once, with no tick', () => {
    let { state } = boot(reduce, llPlaylist({ msn: 10, segments: 3, trailing: 2 }));
    const [ticked, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    state = ticked;
    expect(fetches(fx)).toEqual([expect.objectContaining({ token: REFRESH, url: URL })]);

    let settled = answer(reduce, state, REFRESH, llPlaylist({ msn: 10, segments: 3, trailing: 3 }));
    state = settled.state;
    expect(fetches(settled.effects).filter((f) => f.token === REFRESH)).toEqual([
      expect.objectContaining({ url: `${URL}?_HLS_msn=13&_HLS_part=3&_HLS_skip=YES` }),
    ]);
    expect(reloadTicks(settled.effects)).toEqual([]);
    expect(state.live?.span.end).toBe(15);

    // The next answer completes segment 13: the request moves to 14, part 0.
    settled = answer(
      reduce,
      state,
      REFRESH,
      llPlaylist({ msn: 10, segments: 4, withParts: 1, hint: true }),
    );
    expect(fetches(settled.effects).filter((f) => f.token === REFRESH)).toEqual([
      expect.objectContaining({ url: `${URL}?_HLS_msn=14&_HLS_part=0&_HLS_skip=YES` }),
    ]);
    expect(settled.state.live?.span.end).toBe(16);
  });

  it('a delta update without the skipped segments reloads the whole playlist at once', () => {
    let { state } = boot(reduce, llPlaylist({ msn: 10, segments: 3, trailing: 2 }));
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    const settled = answer(
      reduce,
      state,
      REFRESH,
      llPlaylist({ msn: 40, segments: 3, skipped: 3, trailing: 1 }),
    );
    const reloads = fetches(settled.effects).filter((f) => f.token === REFRESH);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]?.url).not.toContain('_HLS_skip');
    // Nothing merged from the unfillable delta.
    expect(settled.state.live?.span.end).toBe(14);
  });

  it('a server that does not block reloads on the target duration, as hls-live does', () => {
    const control = 'PART-HOLD-BACK=3.0,HOLD-BACK=12.0';
    let { state } = boot(reduce, llPlaylist({ msn: 10, segments: 3, trailing: 2, control }));
    const [ticked, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    state = ticked;
    expect(fetches(fx)).toEqual([expect.objectContaining({ url: URL })]);
    const settled = answer(
      reduce,
      state,
      REFRESH,
      llPlaylist({ msn: 10, segments: 3, trailing: 3, control }),
    );
    expect(fetches(settled.effects).filter((f) => f.token === REFRESH)).toEqual([]);
    expect(reloadTicks(settled.effects)).toEqual([expect.objectContaining({ delayMs: 4000 })]);
  });

  it('a playlist without parts plays its segments at HOLD-BACK', () => {
    const plain = llPlaylist({
      msn: 10,
      segments: 5,
      hint: false,
      control: 'HOLD-BACK=8.0',
    }).replace('#EXT-X-PART-INF:PART-TARGET=1.0\n', '');
    const { state } = boot(reduce, plain);
    expect(state.live).toEqual({ span: { start: 0, end: 20 }, edge: 12 });
  });

  it('SUSPEND aborts the blocking reload', () => {
    let { state } = boot(reduce, llPlaylist({ msn: 10, segments: 3, trailing: 2 }));
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    state = answer(reduce, state, REFRESH, llPlaylist({ msn: 10, segments: 3, trailing: 3 })).state;
    const [, fx] = reduce(state, { type: 'SUSPEND' });
    expect(fx).toContainEqual({ kind: 'abort', token: REFRESH });
  });

  it('a switch loads the new playlist from its rendition report', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401f"',
      'lo.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f"',
      'hi.m3u8',
    ].join('\n');
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: `${BASE}master.m3u8` });
    let settled = answer(reduce, state, 'manifest', master);
    state = settled.state;
    const report = '#EXT-X-RENDITION-REPORT:URI="hi.m3u8",LAST-MSN=13,LAST-PART=1';
    for (const fetch of fetches(settled.effects).filter((f) => f.token.startsWith('hls:pl:'))) {
      settled = answer(
        reduce,
        state,
        fetch.token,
        llPlaylist({ msn: 10, segments: 3, trailing: 2, reports: [report] }),
      );
      state = settled.state;
    }
    expect(state.quality.active).toBe('v-1000000');
    [state] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    // ABR moves up; the next answer of the blocking reload notices it.
    [state] = reduce(state, { type: 'PIN_RENDITION', renditionId: 'v-3000000', apply: 'next' });
    settled = answer(
      reduce,
      state,
      'hls:live:refresh:v-1000000',
      llPlaylist({ msn: 10, segments: 3, trailing: 3, reports: [report] }),
    );
    expect(fetches(settled.effects)).toContainEqual(
      expect.objectContaining({
        token: 'hls:live:refresh:v-3000000',
        url: `${BASE}hi.m3u8?_HLS_msn=13&_HLS_part=1`,
      }),
    );
  });
});

describe('hls-ll companions', () => {
  const reduce = compose(hlsLl);

  it('the audio playlist keeps its own blocking reload, and the tick leaves it alone', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"',
      'video.m3u8',
    ].join('\n');
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: `${BASE}master.m3u8` });
    let settled = answer(reduce, state, 'manifest', master);
    state = settled.state;
    for (const fetch of fetches(settled.effects).filter((f) => f.token.startsWith('hls:pl:'))) {
      settled = answer(
        reduce,
        state,
        fetch.token,
        llPlaylist({ msn: 10, segments: 3, trailing: 2 }),
      );
      state = settled.state;
    }
    const [ticked, fx] = reduce(state, { type: 'TICK', token: 'hls-live:reload' });
    state = ticked;
    const audio = 'hls:live:refresh:a:en';
    expect(fetches(fx).map((f) => f.token)).toEqual(['hls:live:refresh:v-1000000', audio]);
    settled = answer(reduce, state, audio, llPlaylist({ msn: 10, segments: 3, trailing: 3 }));
    state = settled.state;
    expect(fetches(settled.effects)).toEqual([
      expect.objectContaining({
        token: audio,
        url: `${BASE}audio.m3u8?_HLS_msn=13&_HLS_part=3&_HLS_skip=YES`,
      }),
    ]);
    // The video answer chains too; nothing waits for a tick any more.
    settled = answer(
      reduce,
      state,
      'hls:live:refresh:v-1000000',
      llPlaylist({ msn: 10, segments: 3, trailing: 3 }),
    );
    expect(reloadTicks(settled.effects)).toEqual([]);
    expect(fetches(settled.effects).map((f) => f.token)).toEqual(['hls:live:refresh:v-1000000']);
  });
});

describe('hls-live without low latency', () => {
  const reduce = compose(hlsCmaf, hlsLive);

  it('holds back HOLD-BACK when the playlist declares it (RFC 8216bis §4.4.3.8)', () => {
    const plain = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-SERVER-CONTROL:HOLD-BACK=6.0',
      '#EXT-X-MEDIA-SEQUENCE:5',
      ...Array.from({ length: 5 }, (_, i) => ['#EXTINF:4.0,', `seg-${5 + i}.mp4`]).flat(),
    ].join('\n');
    const { state } = boot(reduce, plain);
    expect(state.live).toEqual({ span: { start: 0, end: 20 }, edge: 14 });
  });

  it('plays an LL-HLS playlist from whole segments, on the cadence', () => {
    const { state, effects } = boot(reduce, llPlaylist({ msn: 10, segments: 3, trailing: 2 }));
    expect(state.live).toEqual({ span: { start: 0, end: 12 }, edge: 0 });
    expect(reloadTicks(effects)).toEqual([expect.objectContaining({ delayMs: 4000 })]);
    const segments = state.presentation?.periods[0]?.tracks[0]?.renditions[0]?.segments;
    expect((segments as readonly Segment[]).map((s) => s.seq)).toEqual([10, 11, 12]);
  });
});
