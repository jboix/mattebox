import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findBox,
  findBoxes,
  normalizeTfdt,
  parseSidx,
  parseTfdt,
  trackTimescales,
  walkBoxes,
} from '../../../src/containers/mp4-box/index.js';
import { reconcileTfdt } from '../../../src/kernel/timeline.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/segments');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function tree(data: Uint8Array): string[] {
  const out: string[] = [];
  walkBoxes(data, (box) => {
    out.push(`${box.path === '' ? '' : `${box.path}/`}${box.type} @${box.start} +${box.size}`);
    return undefined;
  });
  return out;
}

describe('box walking over the init corpus', () => {
  const corpus = [
    'init-v-base.mp4',
    'init-v-main.mp4',
    'init-v-high.mp4',
    'init-v-hevc.mp4',
    'init-v-vp9.mp4',
    'init-v-av1.mp4',
    'init-a.mp4',
    'init-a-opus.mp4',
    'init-a-ac3.mp4',
    'init-a-ec3.mp4',
  ];
  for (const name of corpus) {
    it(`${name} walks to a stable box tree`, () => {
      expect(tree(fixture(name))).toMatchSnapshot();
    });
  }

  it('finds boxes by path, repeatedly for repeating boxes', () => {
    const init = fixture('init-v-base.mp4');
    expect(findBox(init, 'moov')).not.toBeNull();
    expect(findBox(init, 'moov/trak/mdia/minf/stbl/stsd')).not.toBeNull();
    expect(findBoxes(init, 'moov/trak')).toHaveLength(1);
    expect(findBox(init, 'nope')).toBeNull();
  });
});

describe('64-bit sizes', () => {
  it('parses a largesize box header', () => {
    // ftyp with size=1 and a 64-bit size of 16.
    const data = new Uint8Array([
      0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 24, 0x69, 0x73, 0x6f, 0x35, 0, 0, 0,
      0,
    ]);
    const boxes = tree(data);
    expect(boxes).toEqual(['ftyp @0 +24']);
  });

  it('size zero extends to the end of the buffer', () => {
    const data = new Uint8Array([0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74, 1, 2, 3, 4]);
    expect(tree(data)).toEqual(['mdat @0 +12']);
  });
});

describe('FullBox version variants', () => {
  it('tfdt version 0 and version 1 both parse', () => {
    const v0 = new Uint8Array([0, 0, 0, 0, 0, 0, 0x30, 0x39]);
    expect(parseTfdt(v0)).toEqual({ version: 0, baseMediaDecodeTime: 12345 });

    const v1 = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(parseTfdt(v1)).toEqual({ version: 1, baseMediaDecodeTime: 2 ** 32 });
  });

  it('a real tfdt feeds timeline reconciliation', () => {
    // The media segment from the corpus carries moof/traf/tfdt.
    const seg = fixture('seg-v-base-1.m4s');
    const tfdtBox = findBox(seg, 'moof/traf/tfdt');
    expect(tfdtBox).not.toBeNull();
    const tfdt = parseTfdt((tfdtBox as NonNullable<typeof tfdtBox>).payload);
    expect(tfdt).not.toBeNull();
    const epoch = { periodId: 'p0', firstSeq: 0, presentationStart: 10, mediaStart: 0 };
    const corrected = reconcileTfdt(
      epoch,
      (tfdt as NonNullable<typeof tfdt>).baseMediaDecodeTime,
      12800,
    );
    expect(Number.isFinite(corrected.mediaStart)).toBe(true);
  });

  it('sidx version 0 and version 1 both parse, including references', () => {
    const v0 = new Uint8Array([
      0,
      0,
      0,
      0, // fullbox
      0,
      0,
      0,
      1, // reference id
      0,
      0,
      0x03,
      0xe8, // timescale 1000
      0,
      0,
      0,
      100, // earliest pts
      0,
      0,
      0,
      0, // first offset
      0,
      0, // reserved
      0,
      1, // count
      0x00,
      0,
      0x10,
      0, // size 4096
      0,
      0,
      0x0f,
      0xa0, // duration 4000
      0x80,
      0,
      0,
      0, // starts with SAP
    ]);
    expect(parseSidx(v0)).toEqual({
      version: 0,
      referenceId: 1,
      timescale: 1000,
      earliestPresentationTime: 100,
      firstOffset: 0,
      references: [{ referencedSize: 4096, subsegmentDuration: 4000, startsWithSap: true }],
    });

    const v1 = new Uint8Array([
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      2,
      0,
      0,
      0x27,
      0x10, // timescale 10000
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0, // earliest pts (64-bit) 2^32
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      8, // first offset 8
      0,
      0,
      0,
      0, // zero references
    ]);
    expect(parseSidx(v1)).toEqual({
      version: 1,
      referenceId: 2,
      timescale: 10000,
      earliestPresentationTime: 2 ** 32,
      firstOffset: 8,
      references: [],
    });
  });
});

describe('malformed input never throws and never loops', () => {
  it('fuzz: valid fixtures truncated at many offsets fail cleanly', () => {
    const init = fixture('init-v-base.mp4');
    for (let cut = 1; cut < Math.min(init.byteLength, 400); cut += 7) {
      const truncated = init.subarray(0, cut);
      const result = walkBoxes(truncated, () => undefined);
      // Either a clean walk of the surviving prefix or a typed error;
      // reaching this line at all proves no throw and no hang.
      if (result.error !== null) {
        expect(result.error.code).toBe('MEDIA_CONTAINER_INVALID');
        expect(result.error.category).toBe('media');
      }
    }
  });

  it('a box claiming a size smaller than its header stops with an error', () => {
    const data = new Uint8Array([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]);
    const result = walkBoxes(data, () => undefined);
    expect(result.error?.code).toBe('MEDIA_CONTAINER_INVALID');
    expect(result.error?.context).toMatchObject({ reason: 'box size smaller than header' });
  });

  it('a box extending past its container stops with an error', () => {
    const data = new Uint8Array([0, 0, 0, 99, 0x66, 0x72, 0x65, 0x65, 0, 0]);
    const result = walkBoxes(data, () => undefined);
    expect(result.error?.context).toMatchObject({ reason: 'box extends past its container' });
  });

  it('an oversized 64-bit size is an error, not an allocation', () => {
    const data = new Uint8Array(24);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1);
    data.set([0x6d, 0x64, 0x61, 0x74], 4);
    view.setBigUint64(8, 2n ** 60n);
    const result = walkBoxes(data, () => undefined);
    expect(result.error?.context).toMatchObject({ reason: 'size overflow' });
  });
});

describe('CMAF timing normalization', () => {
  it('reads each track timescale from a real init segment', () => {
    const timescales = trackTimescales(fixture('rts-cmaf-video-init.mp4'));
    // The RTS Info CMAF video init declares track 1 at a 50000 timescale.
    expect(timescales.get(1)).toBe(50000);
  });

  // A minimal moof/traf with a tfhd (track_ID) and a version-1 tfdt.
  function fragment(trackId: number, baseMediaDecodeTime: bigint): Uint8Array {
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
    const tfhd = box('tfhd', [0, 0, 0, 0, ...u32(trackId)]);
    const tfdt = box('tfdt', [1, 0, 0, 0, ...u64(baseMediaDecodeTime)]);
    const traf = box('traf', [...tfhd, ...tfdt]);
    return new Uint8Array(box('moof', traf));
  }

  it('rewrites a broadcast-clock tfdt to the presentation start times the timescale', () => {
    const segment = fragment(1, 89_418_813_200_000n);
    const rewritten = normalizeTfdt(segment, 7188, new Map([[1, 50000]]), 50000);
    expect(rewritten).toBe(1);
    const tfdt = parseTfdt(findBox(segment, 'moof/traf/tfdt')?.payload as Uint8Array);
    expect(tfdt?.baseMediaDecodeTime).toBe(7188 * 50000);
  });

  it('is a no-op for VOD whose media clock already starts at zero', () => {
    const segment = fragment(1, 0n);
    normalizeTfdt(segment, 0, new Map([[1, 50000]]), 50000);
    const tfdt = parseTfdt(findBox(segment, 'moof/traf/tfdt')?.payload as Uint8Array);
    expect(tfdt?.baseMediaDecodeTime).toBe(0);
  });
});
