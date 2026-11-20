// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cuesToSegments,
  readCues,
  readInit,
  type WebmInit,
} from '../../../src/containers/webm/cues.js';
import webm from '../../../src/containers/webm/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import dashCmaf from '../../../src/protocols/dash-cmaf/index.js';
import { parse } from '../../../src/protocols/dash-cmaf/parse.js';
import type { Rendition, Segment, SidxSegments } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { Capability, Stage } from '../../../src/types/stage.js';

// EBML writing, RFC 8794: an ID keeps its length marker, a size is a VINT.

/** The bytes of an Element ID, as written in the specification. */
function id(value: number): number[] {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** A data size as an eight-byte VINT, the widest form, so any size fits. */
function size(value: number): number[] {
  const out = [0x01];
  for (let i = 6; i >= 0; i -= 1) out.push(Math.floor(value / 256 ** i) % 256);
  return out;
}

/** One element: ID, size, data. */
function el(elementId: number, ...data: number[][]): number[] {
  const body = data.flat();
  return [...id(elementId), ...size(body.length), ...body];
}

/** An unsigned integer element in as few bytes as it needs. */
function uint(elementId: number, value: number): number[] {
  const bytes: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return el(elementId, bytes.length === 0 ? [0] : bytes);
}

/** A float element, eight bytes. */
function float(elementId: number, value: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return el(elementId, [...new Uint8Array(view.buffer)]);
}

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;

/** The EBML header of a WebM file: DocType "webm". */
const HEADER = el(
  EBML,
  el(
    0x4282,
    [...'webm'].map((c) => c.charCodeAt(0)),
  ),
);

/**
 * An initialization range: EBML header, then a Segment of `segmentSize`
 * bytes holding a SeekHead, Info and Tracks. The Segment's data runs past
 * these bytes, as in a real file.
 */
function initBytes(options: {
  scale?: number;
  duration?: number;
  segmentSize?: number | 'unknown';
}): Uint8Array {
  const info = el(
    INFO,
    ...(options.scale !== undefined ? [uint(TIMESTAMP_SCALE, options.scale)] : []),
    ...(options.duration !== undefined ? [float(DURATION, options.duration)] : []),
  );
  const children = [...el(SEEK_HEAD, [0xec, 0x80]), ...info, ...el(TRACKS, [0xae, 0x80])];
  const declared =
    options.segmentSize === 'unknown'
      ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
      : size(options.segmentSize ?? 100_000);
  return new Uint8Array([...HEADER, ...id(SEGMENT), ...declared, ...children]);
}

/** A Cues element, one CuePoint per [time, clusterPosition]. */
function cuesBytes(points: ReadonlyArray<readonly [number, number]>): Uint8Array {
  return new Uint8Array(
    el(
      CUES,
      ...points.map(([time, position]) =>
        el(
          CUE_POINT,
          uint(CUE_TIME, time),
          el(CUE_TRACK_POSITIONS, uint(CUE_TRACK, 1), uint(CUE_CLUSTER_POSITION, position)),
        ),
      ),
    ),
  );
}

/** Where the Segment's data starts in `initBytes`: header, Segment ID, eight-byte size. */
const SEGMENT_START = HEADER.length + 4 + 8;

function addressing(indexStart: number, extra: Partial<SidxSegments> = {}): SidxSegments {
  return {
    kind: 'sidx',
    url: 'https://cdn.example/v.webm',
    indexRange: { start: indexStart, end: indexStart + 99 },
    timescale: 1,
    format: 'webm',
    ...extra,
  };
}

describe('readInit', () => {
  it('reads the Segment start, its size, the scale and the duration', () => {
    const init = readInit(initBytes({ scale: 1_000_000, duration: 12_000, segmentSize: 5000 }));
    expect(init).toEqual({
      segmentStart: SEGMENT_START,
      segmentSize: 5000,
      tickSeconds: 0.001,
      duration: 12,
    });
  });

  it('defaults TimestampScale to a millisecond, RFC 9559 §5.1.2.9', () => {
    expect(readInit(initBytes({ duration: 4000 }))?.tickSeconds).toBe(0.001);
  });

  it('applies another TimestampScale to the duration', () => {
    const init = readInit(initBytes({ scale: 100_000, duration: 40_000 }));
    expect(init?.tickSeconds).toBeCloseTo(0.0001);
    expect(init?.duration).toBeCloseTo(4);
  });

  it('reads an unknown Segment size as null', () => {
    expect(readInit(initBytes({ duration: 1, segmentSize: 'unknown' }))?.segmentSize).toBeNull();
  });

  it('reports a missing Duration as null', () => {
    expect(readInit(initBytes({}))?.duration).toBeNull();
  });

  it('refuses bytes that do not start with an EBML header and a Segment', () => {
    expect(readInit(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBeNull();
    expect(readInit(new Uint8Array(HEADER))).toBeNull();
    expect(readInit(new Uint8Array([]))).toBeNull();
  });

  it('refuses a Segment with no Info, and never throws on truncation', () => {
    const noInfo = new Uint8Array([...HEADER, ...id(SEGMENT), ...size(50), ...el(TRACKS)]);
    expect(readInit(noInfo)).toBeNull();
    const full = initBytes({ duration: 1000 });
    for (let cut = 0; cut < full.length; cut += 1) {
      expect(() => readInit(full.subarray(0, cut))).not.toThrow();
    }
  });
});

describe('readCues', () => {
  it('reads each CuePoint time and Cluster position', () => {
    expect(
      readCues(
        cuesBytes([
          [0, 300],
          [4000, 90_000],
        ]),
      ),
    ).toEqual([
      { time: 0, position: 300 },
      { time: 4000, position: 90_000 },
    ]);
  });

  it('takes the first CueTrackPositions and reads children in any order', () => {
    const point = el(
      CUE_POINT,
      el(CUE_TRACK_POSITIONS, uint(CUE_CLUSTER_POSITION, 10), uint(CUE_TRACK, 1)),
      el(CUE_TRACK_POSITIONS, uint(CUE_TRACK, 2), uint(CUE_CLUSTER_POSITION, 99)),
      uint(CUE_TIME, 7),
    );
    expect(readCues(new Uint8Array(el(CUES, point)))).toEqual([{ time: 7, position: 10 }]);
  });

  it('skips a CuePoint without a time or a position', () => {
    const bad = el(CUE_POINT, uint(CUE_TIME, 5));
    expect(readCues(new Uint8Array(el(CUES, bad)))).toEqual([]);
  });

  it('refuses bytes that are not Cues, and never throws on truncation', () => {
    expect(readCues(new Uint8Array(el(INFO)))).toBeNull();
    expect(readCues(new Uint8Array([0]))).toBeNull();
    const full = cuesBytes([
      [0, 1],
      [2000, 500],
      [4000, 900],
    ]);
    for (let cut = 0; cut < full.length; cut += 1) {
      expect(() => readCues(full.subarray(0, cut))).not.toThrow();
    }
  });
});

describe('cuesToSegments', () => {
  const init: WebmInit = {
    segmentStart: 40,
    segmentSize: 10_000,
    tickSeconds: 0.001,
    duration: 10,
  };
  const initRange = { start: 0, end: 39 + 200 };
  const points = [
    { time: 0, position: 200 },
    { time: 4000, position: 3000 },
    { time: 8000, position: 6000 },
  ];

  it('gives one segment per Cluster, positions counted from the Segment data', () => {
    // The Cues follow the last Cluster, as ffmpeg writes them.
    const segments = cuesToSegments(init, initRange, points, addressing(9000));
    expect(segments).toEqual([
      {
        seq: 0,
        start: 0,
        duration: 4,
        url: 'https://cdn.example/v.webm',
        byteRange: { start: 240, end: 3039 },
      },
      {
        seq: 1,
        start: 4,
        duration: 4,
        url: 'https://cdn.example/v.webm',
        byteRange: { start: 3040, end: 6039 },
      },
      {
        seq: 2,
        start: 8,
        duration: 2,
        url: 'https://cdn.example/v.webm',
        byteRange: { start: 6040, end: 8999 },
      },
    ]);
  });

  it('ends the last segment at the end of the Segment when the Cues come first', () => {
    const segments = cuesToSegments(init, initRange, points, addressing(240));
    expect(segments[2]?.byteRange).toEqual({ start: 6040, end: 40 + 10_000 - 1 });
  });

  it('leaves the last range open when the Cues come first and the Segment size is unknown', () => {
    const open = { ...init, segmentSize: null };
    const segments = cuesToSegments(open, initRange, points, addressing(240));
    expect(segments[2]?.byteRange).toEqual({ start: 6040, end: Number.POSITIVE_INFINITY });
  });

  it('adds the start of the initialization range to every offset', () => {
    const segments = cuesToSegments(init, { start: 1000, end: 1239 }, points, addressing(10_000));
    expect(segments[0]?.byteRange?.start).toBe(1240);
  });

  it('opens one segment per Cluster when several CuePoints name it', () => {
    const shared = [
      { time: 0, position: 200 },
      { time: 2000, position: 200 },
      { time: 4000, position: 3000 },
    ];
    const segments = cuesToSegments(init, initRange, shared, addressing(9000));
    expect(segments.map((s) => [s.start, s.duration])).toEqual([
      [0, 4],
      [4, 6],
    ]);
  });

  it('subtracts the presentation time offset', () => {
    const segments = cuesToSegments(
      init,
      initRange,
      points,
      addressing(9000, { presentationTimeOffset: 4 }),
    );
    expect(segments.map((s) => s.start)).toEqual([-4, 0, 4]);
  });

  it('gives nothing without a Duration, which the last segment needs', () => {
    expect(
      cuesToSegments({ ...init, duration: null }, initRange, points, addressing(9000)),
    ).toEqual([]);
  });
});

describe('a WebM file from ffmpeg', () => {
  // ffmpeg 7.1 `-f webm -dash 1`: 24 s of VP9 at 320x180, a key frame every
  // 4 s. Its MPD says Initialization range="0-472" and indexRange="486535-486651".
  const dir = join(import.meta.dirname, '../../fixtures/segments');
  const init = readInit(new Uint8Array(readFileSync(join(dir, 'webm-vp9-init.bin'))));
  const cues = readCues(new Uint8Array(readFileSync(join(dir, 'webm-vp9-cues.bin'))));

  it('reads its Info and its Cues', () => {
    // The Segment's data starts at byte 48 and runs to the end of the 486,652-byte file.
    expect(init).toMatchObject({ segmentStart: 48, segmentSize: 486_604, tickSeconds: 0.001 });
    expect(init?.duration).toBeCloseTo(24, 1);
    expect(cues?.map((c) => c.time)).toEqual([0, 4000, 8000, 12_000, 16_000, 20_000]);
  });

  it('turns them into six contiguous segments that end where the Cues start', () => {
    const segments = cuesToSegments(
      init as WebmInit,
      { start: 0, end: 472 },
      cues ?? [],
      addressing(486_535),
    );
    expect(segments).toHaveLength(6);
    expect(segments[0]?.byteRange?.start).toBe(473);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.byteRange?.start).toBe((segments[i - 1]?.byteRange?.end ?? 0) + 1);
    }
    expect(segments[5]?.byteRange?.end).toBe(486_534);
  });
});

/** A WebM on-demand MPD as ffmpeg's webm_dash_manifest writes it: codecs, sizes on the AdaptationSet. */
const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:DASH:schema:MPD:2011" type="static" mediaPresentationDuration="PT10S"
  profiles="urn:mpeg:dash:profile:webm-on-demand:2012">
  <Period id="0" start="PT0S" duration="PT10S">
    <AdaptationSet id="0" mimeType="video/webm" codecs="vp9" width="320" height="180">
      <Representation id="v1" bandwidth="150000">
        <BaseURL>v1.webm</BaseURL>
        <SegmentBase indexRange="9000-9099"><Initialization range="0-239"/></SegmentBase>
      </Representation>
      <Representation id="v2" bandwidth="300000">
        <BaseURL>v2.webm</BaseURL>
        <SegmentBase indexRange="9000-9099"><Initialization range="0-239"/></SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" mimeType="audio/webm" codecs="opus" lang="en">
      <Representation id="a1" bandwidth="64000">
        <BaseURL>a.webm</BaseURL>
        <SegmentBase indexRange="9000-9099"><Initialization range="0-239"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const WEBM_FORMATS: readonly Capability[] = webm().provides ?? [];

describe('dash-cmaf parse with WebM', () => {
  it('leaves WebM out when no stage reads it', () => {
    const { presentation } = parse(MPD, 'https://cdn.example/m.mpd');
    expect(presentation).toBeNull();
  });

  it('keeps WebM SegmentBase as unresolved addressing marked webm', () => {
    const { presentation } = parse(MPD, 'https://cdn.example/m.mpd', false, WEBM_FORMATS);
    const tracks = presentation?.periods[0]?.tracks ?? [];
    expect(tracks.map((t) => [t.contentType, t.mimeType])).toEqual([
      ['video', 'video/webm'],
      ['audio', 'audio/webm'],
    ]);
    const video = tracks[0]?.renditions[0] as Rendition;
    expect(video.codecs).toBe('vp9');
    expect(video.init).toEqual({
      url: 'https://cdn.example/v1.webm',
      byteRange: { start: 0, end: 239 },
    });
    expect(video.segments).toMatchObject({
      kind: 'sidx',
      format: 'webm',
      indexRange: { start: 9000, end: 9099 },
    });
  });

  it('leaves out a WebM SegmentBase without an initialization range', () => {
    const bare = MPD.replace(/<Initialization range="0-239"\/>/g, '');
    const { presentation } = parse(bare, 'https://cdn.example/m.mpd', false, WEBM_FORMATS);
    expect(presentation).toBeNull();
  });

  it('marks no ISO BMFF SegmentBase as webm', () => {
    const mp4 = MPD.replace(/video\/webm/, 'video/mp4').replace(/audio\/webm/, 'audio/mp4');
    const { presentation } = parse(mp4, 'https://cdn.example/m.mpd', false, WEBM_FORMATS);
    const segments = presentation?.periods[0]?.tracks[0]?.renditions[0]?.segments;
    expect(segments).not.toHaveProperty('format');
  });
});

type Reduce = ReturnType<typeof createReducer>;

/** Installs the stages against a stub context and builds the kernel reducer from their slices. */
function compose(...stages: Stage[]): Reduce {
  const slices: Array<readonly [string, SliceReducer]> = [];
  const capabilities: Capability[] = stages.flatMap((stage) => stage.provides ?? []);
  for (const stage of stages) {
    stage.install({
      element: new EventTarget() as unknown as HTMLMediaElement,
      registerSink: () => undefined,
      registerParser: () => undefined,
      capabilities: () => capabilities,
      registerTransform: () => undefined,
      registerNamespace: () => undefined,
      registerChooser: () => undefined,
      registerSwitchPolicy: () => undefined,
      registerTypeProbe: () => undefined,
      registerTimeProbe: () => undefined,
      registerChunkSplitter: () => undefined,
      getState: () => initialState(),
      addRequestHook: () => () => undefined,
      addResponseHook: () => () => undefined,
      request: async () => new Response(),
      reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
      dispatch: () => undefined,
      load: () => undefined,
      preload: async () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
    });
  }
  return createReducer(slices);
}

/** Follows zero-delay loop-back schedule effects the way the runner would. */
function settle(
  reduce: Reduce,
  state: KernelState,
  effects: readonly Effect[],
): { state: KernelState; effects: Effect[] } {
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

type Fetch = Extract<Effect, { kind: 'fetch' }>;

function fetches(effects: readonly Effect[], prefix: string): Fetch[] {
  return effects.filter((e): e is Fetch => e.kind === 'fetch' && e.token.startsWith(prefix));
}

function loaded(token: string, body: Uint8Array | string): Message {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    type: 'SEGMENT_LOADED',
    trackId: token,
    seq: 0,
    token,
    bytes: bytes.slice().buffer as ArrayBuffer,
    rtt: 5,
    size: bytes.byteLength,
  };
}

function segmentsOf(state: KernelState, renditionId: string): readonly Segment[] {
  for (const period of state.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId && Array.isArray(rendition.segments)) {
          return rendition.segments as readonly Segment[];
        }
      }
    }
  }
  return [];
}

describe('the webm stage resolves the indexes the selection needs', () => {
  const reduce = compose(dashCmaf(), webm());
  const INIT = initBytes({ duration: 10_000, segmentSize: 9000 });
  const CUE_BYTES = cuesBytes([
    [0, 200],
    [4000, 3000],
    [8000, 6000],
  ]);

  function boot(): { state: KernelState; effects: Effect[] } {
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/m.mpd' });
    const token = [...state.scheduling.inflight.keys()][0] as string;
    const manifest = { ...loaded('manifest', MPD), token } as Message;
    return settle(reduce, ...reduce(state, manifest));
  }

  it('fetches the initialization range and the Cues of the playing renditions', () => {
    const { effects } = boot();
    expect(fetches(effects, 'dash:idx:')).toEqual([]);
    expect(fetches(effects, 'webm:').map((f) => [f.token, f.range])).toEqual([
      ['webm:init:v1', { start: 0, end: 239 }],
      ['webm:cues:v1', { start: 9000, end: 9099 }],
      ['webm:init:v2', { start: 0, end: 239 }],
      ['webm:cues:v2', { start: 9000, end: 9099 }],
      ['webm:init:a1', { start: 0, end: 239 }],
      ['webm:cues:a1', { start: 9000, end: 9099 }],
    ]);
  });

  it('merges the segments once both parts land, in either order, and asks no more', () => {
    const booted = boot();
    let state = booted.state;
    const produced: Effect[] = [];
    for (const message of [
      loaded('webm:cues:v1', CUE_BYTES),
      loaded('webm:init:v1', INIT),
      loaded('webm:init:a1', INIT),
      loaded('webm:cues:a1', CUE_BYTES),
    ]) {
      const [next, fx] = reduce(state, message);
      state = next;
      produced.push(...fx);
    }
    const settled = settle(reduce, state, produced);
    const segments = segmentsOf(settled.state, 'v1');
    expect(segments.map((s) => [s.start, s.duration, s.byteRange])).toEqual([
      [0, 4, { start: SEGMENT_START + 200, end: SEGMENT_START + 2999 }],
      [4, 4, { start: SEGMENT_START + 3000, end: SEGMENT_START + 5999 }],
      [8, 2, { start: SEGMENT_START + 6000, end: 8999 }],
    ]);
    expect(segmentsOf(settled.state, 'a1')).toHaveLength(3);
    const [, timeFx] = reduce(settled.state, { type: 'TIME_UPDATE', currentTime: 1, buffered: [] });
    const tokens = fetches([...booted.effects, ...settled.effects, ...timeFx], 'webm:').map(
      (f) => f.token,
    );
    expect(tokens).toHaveLength(new Set(tokens).size);
  });

  it('an index it cannot read is reported, excluded, and retried after its delay', () => {
    const booted = boot();
    const failed = settle(
      reduce,
      ...reduce(booted.state, loaded('webm:cues:v2', new Uint8Array(8))),
    );
    expect(failed.effects).toContainEqual(
      expect.objectContaining({
        kind: 'emit',
        event: 'error',
        payload: expect.objectContaining({ code: 'MEDIA_CONTAINER_INVALID', renditionId: 'v2' }),
      }),
    );
    expect(failed.state.quality.constraints.get('webm:unavailable')?.excludeIds).toEqual(['v2']);
    expect(failed.effects).toContainEqual(
      expect.objectContaining({ kind: 'schedule', token: 'webm:retry:v2', delayMs: 15_000 }),
    );
    // The init that was still on its way changes nothing.
    const late = settle(reduce, ...reduce(failed.state, loaded('webm:init:v2', INIT)));
    expect(segmentsOf(late.state, 'v2')).toEqual([]);
    const retried = settle(reduce, ...reduce(late.state, { type: 'TICK', token: 'webm:retry:v2' }));
    expect(retried.state.quality.constraints.get('webm:unavailable')?.excludeIds).toEqual([]);
  });

  it('fails the load when every rendition of a media track fails', () => {
    const booted = boot();
    const failed = settle(
      reduce,
      ...reduce(booted.state, loaded('webm:init:a1', new Uint8Array(4))),
    );
    expect(failed.state.lifecycle.phase).toBe('error');
  });
});
