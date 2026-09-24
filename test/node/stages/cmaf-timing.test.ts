import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findBox, parseTfdt } from '../../../src/containers/mp4-box/index.js';
import cmafTiming from '../../../src/stages/cmaf-timing/index.js';
import type { SegmentMeta } from '../../../src/types/messages.js';
import type { MediaTimeProbe, StageContext } from '../../../src/types/stage.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../fixtures/segments/${name}`, import.meta.url))),
  );
}

/** Installs the stage against a context that only records the probe. */
function installed(): MediaTimeProbe {
  let probe: MediaTimeProbe | null = null;
  cmafTiming().install({
    registerTimeProbe: (p: MediaTimeProbe) => {
      probe = p;
    },
  } as unknown as StageContext);
  if (probe === null) throw new Error('no probe registered');
  return probe;
}

function meta(overrides: Partial<SegmentMeta>): SegmentMeta {
  return {
    trackId: 'v',
    renditionId: 'v-1',
    contentType: 'video',
    seq: 0,
    start: 0,
    duration: 4,
    isInit: false,
    ...overrides,
  };
}

// Minimal ISOBMFF builders: a moov with one trak per (id, timescale), and a
// moof/traf with a tfhd track_ID and a version-1 tfdt.
const box = (type: string, body: number[]): number[] => {
  const size = 8 + body.length;
  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...body,
  ];
};
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const u64 = (n: bigint): number[] => {
  const out: number[] = [];
  for (let i = 7; i >= 0; i -= 1) out.push(Number((n >> BigInt(i * 8)) & 0xffn));
  return out;
};
function init(tracks: Array<[id: number, timescale: number]>): Uint8Array {
  const traks = tracks.flatMap(([id, timescale]) =>
    box('trak', [
      // tkhd v0: version/flags, creation, modification, track_ID.
      ...box('tkhd', [...u32(0), ...u32(0), ...u32(0), ...u32(id)]),
      // mdhd v0: version/flags, creation, modification, timescale, duration.
      ...box('mdia', box('mdhd', [...u32(0), ...u32(0), ...u32(0), ...u32(timescale), ...u32(0)])),
    ]),
  );
  return new Uint8Array(box('moov', traks));
}
function fragment(trackId: number, baseMediaDecodeTime: bigint): number[] {
  const tfhd = box('tfhd', [0, 0, 0, 0, ...u32(trackId)]);
  const tfdt = box('tfdt', [1, 0, 0, 0, ...u64(baseMediaDecodeTime)]);
  return box('moof', box('traf', [...tfhd, ...tfdt]));
}

describe('cmaf-timing', () => {
  it('reads a real segment start once the rendition init taught it the timescale', () => {
    const probe = installed();
    const seg = fixture('seg-v-base-1.m4s');
    const tfdt = parseTfdt(findBox(seg, 'moof/traf/tfdt')?.payload as Uint8Array);
    // Before the init: nothing to read against.
    expect(probe(seg, meta({}))).toBeNull();
    expect(probe(fixture('init-v-base.mp4'), meta({ seq: -1, isInit: true }))).toBeNull();
    expect(probe(seg, meta({}))).toBe((tfdt?.baseMediaDecodeTime as number) / 12800);
  });

  it('reports the earliest fragment of a multi-fragment segment and leaves the bytes alone', () => {
    const probe = installed();
    probe(
      init([
        [1, 24000],
        [2, 1000],
      ]),
      meta({ seq: -1, isInit: true }),
    );
    // Apple's layout: video fragments about a second apart, a caption track
    // on a 1000 Hz clock beside them, the whole segment starting near 10 s.
    const segment = new Uint8Array([
      ...fragment(1, 238_999n),
      ...fragment(2, 10_000n),
      ...fragment(1, 263_023n),
      ...fragment(1, 290_050n),
    ]);
    const before = [...segment];
    expect(probe(segment, meta({}))).toBeCloseTo(238_999 / 24000, 9);
    expect([...segment]).toEqual(before);
  });

  it('keeps timescales per rendition, so a switch reads the new init', () => {
    const probe = installed();
    probe(init([[1, 90000]]), meta({ renditionId: 'v-1', seq: -1, isInit: true }));
    probe(init([[1, 24000]]), meta({ renditionId: 'v-2', seq: -1, isInit: true }));
    const segment = new Uint8Array(fragment(1, 240_000n));
    expect(probe(segment, meta({ renditionId: 'v-1' }))).toBeCloseTo(240_000 / 90000, 9);
    expect(probe(segment, meta({ renditionId: 'v-2' }))).toBe(10);
    expect(probe(segment, meta({ renditionId: 'v-3' }))).toBeNull();
  });

  it('reads a self-contained segment that carries its own moov', () => {
    const probe = installed();
    const segment = new Uint8Array([...init([[1, 48000]]), ...fragment(1, 96_000n)]);
    expect(probe(segment, meta({ renditionId: 'transmuxed' }))).toBe(2);
  });

  it('ignores cue tracks and bytes without a fragment', () => {
    const probe = installed();
    probe(init([[1, 24000]]), meta({ seq: -1, isInit: true }));
    expect(probe(new Uint8Array(fragment(1, 24_000n)), meta({ contentType: 'text' }))).toBeNull();
    expect(probe(new Uint8Array([0x47, 0, 0, 0]), meta({}))).toBeNull();
  });
});
