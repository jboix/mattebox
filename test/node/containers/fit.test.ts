import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitFragment } from '../../../src/containers/fmp4/fit.js';
import { concat, writeMediaSegment } from '../../../src/containers/fmp4/writer.js';
import {
  decoderConfigBox,
  findBox,
  fragmentSamples,
  fullBox,
  parseTfdt,
  trackTimescales,
  walkBoxes,
} from '../../../src/containers/mp4-box/index.js';
import { programTables } from '../../../src/containers/ts-transmux/demux.js';
import { transmux } from '../../../src/containers/ts-transmux/transmux.js';

const SEGMENTS = join(import.meta.dirname, '../../fixtures/segments');

function segment(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SEGMENTS, name)));
}

function timescaleOf(init: Uint8Array): number {
  return [...trackTimescales(init).values()][0] as number;
}

describe('fitting a trick-play fragment', () => {
  // Apple's I-frame byte range: the moof of a 60-sample fragment, the mdat
  // header, and the first sample only.
  const init = segment('apple-iframe-init.mp4');
  const range = segment('apple-iframe-range.mp4');
  const timescale = timescaleOf(init);

  it('rebuilds an I-frame range as one whole sample lasting the slot', () => {
    const fitted = fitFragment(range, timescale, 2);
    if (fitted === null) throw new Error('expected a rebuilt fragment');
    expect(walkBoxes(fitted, () => undefined).error).toBeNull();
    const [traf] = fragmentSamples(fitted);
    expect(traf?.samples).toHaveLength(1);
    expect(traf?.samples[0]).toMatchObject({ duration: 2 * timescale, isKeyframe: true });
    const [original] = fragmentSamples(range);
    const first = original?.samples[0];
    if (first === undefined || traf === undefined) throw new Error('no samples');
    // The frame's bytes and decode time are the original's.
    const sample = traf.samples[0];
    if (sample === undefined) throw new Error('no fitted sample');
    expect(fitted.subarray(sample.offset, sample.offset + sample.size)).toEqual(
      range.subarray(first.offset, first.offset + first.size),
    );
    const tfdt = (bytes: Uint8Array) =>
      parseTfdt(findBox(bytes, 'moof/traf/tfdt')?.payload ?? new Uint8Array())?.baseMediaDecodeTime;
    expect(tfdt(fitted)).toBe(tfdt(range));
  });

  describe('an encrypted fragment', () => {
    // Two key frames of 40 ms in a 2-second slot, each with an 8-byte IV and
    // two subsamples, the way a CENC packager writes a DASH trick segment.
    const timescale = 90000;
    const entry = (n: number) =>
      new Uint8Array([n, n, n, n, n, n, n, n, 0, 2, 0, 10, 0, 0, 0, 90, 0, 20, 0, 0, 1, 0]);
    const source = writeMediaSegment(7, [
      {
        trackId: 1,
        baseMediaDecodeTime: 900000,
        samples: [1, 2].map((n) => ({
          data: new Uint8Array(100).fill(n),
          duration: 3600,
          cts: 0,
          isKeyframe: true,
        })),
        encryption: { flags: 0x2, entries: [entry(1), entry(2)] },
      },
    ]);

    /** The entries the fragment's saio points at, as many as its saiz sizes. */
    function pointed(bytes: Uint8Array): Uint8Array[] {
      const moof = findBox(bytes, 'moof');
      const saiz = fullBox(findBox(bytes, 'moof/traf/saiz')?.payload ?? new Uint8Array());
      const saio = fullBox(findBox(bytes, 'moof/traf/saio')?.payload ?? new Uint8Array());
      if (moof === null || saiz === null || saio === null) throw new Error('no encryption boxes');
      const size = saiz.body[0] as number;
      const count = new DataView(saiz.body.buffer, saiz.body.byteOffset + 1).getUint32(0);
      const offset = new DataView(saio.body.buffer, saio.body.byteOffset).getUint32(4);
      return Array.from({ length: count }, (_, i) =>
        bytes.slice(moof.start + offset + i * size, moof.start + offset + (i + 1) * size),
      );
    }

    it('writes saiz, saio and senc that point at the entries', () => {
      expect(pointed(source)).toEqual([entry(1), entry(2)]);
      expect(fullBox(findBox(source, 'moof/traf/senc')?.payload ?? new Uint8Array())?.flags).toBe(
        2,
      );
    });

    it('keeps each kept frame its IV and subsamples when it fills the slot', () => {
      const fitted = fitFragment(source, timescale, 2);
      if (fitted === null) throw new Error('expected a rebuilt fragment');
      expect(walkBoxes(fitted, () => undefined).error).toBeNull();
      expect(fragmentSamples(fitted)[0]?.samples.map((sample) => sample.duration)).toEqual([
        3600,
        2 * timescale - 3600,
      ]);
      expect(pointed(fitted)).toEqual([entry(1), entry(2)]);
    });

    it('leaves a fragment it cannot read the encryption of as it came', () => {
      // A senc without the saiz that sizes its entries.
      const saiz = findBox(source, 'moof/traf/saiz');
      if (saiz === null) throw new Error('no saiz');
      const renamed = source.slice();
      renamed.set([0x66, 0x72, 0x65, 0x65], saiz.start + 4);
      expect(fitFragment(renamed, timescale, 2)).toBeNull();
    });
  });

  it('fails when not even the first sample is present', () => {
    expect(() => fitFragment(range.subarray(0, 900), timescale, 2)).toThrow('no whole key frame');
  });

  // A complete fragment from the corpus.
  const baseInit = segment('init-v-base.mp4');
  const whole = segment('seg-v-base-1.m4s');
  const baseScale = timescaleOf(baseInit);
  const wholeDuration =
    (fragmentSamples(whole)[0]?.samples ?? []).reduce((sum, s) => sum + s.duration, 0) / baseScale;

  it('leaves a whole fragment of key frames that fills its slot as it is', () => {
    // One fit leaves only key frames filling the slot, the shape of a DASH
    // trick-mode segment; a second fit to the same slot has nothing to do.
    const once = fitFragment(whole, baseScale, wholeDuration);
    if (once === null) throw new Error('expected the first fit to rebuild');
    expect(fitFragment(once, baseScale, wholeDuration)).toBeNull();
  });

  it('keeps only the key frames of a fragment that falls short, the last filling the slot', () => {
    const fitted = fitFragment(whole, baseScale, wholeDuration * 3);
    const samples = fitted === null ? [] : (fragmentSamples(fitted)[0]?.samples ?? []);
    const keys = (fragmentSamples(whole)[0]?.samples ?? []).filter((s) => s.isKeyframe);
    expect(samples).toHaveLength(keys.length);
    expect(samples.every((s) => s.isKeyframe)).toBe(true);
    expect(samples.reduce((sum, s) => sum + s.duration, 0)).toBe(
      Math.round(wholeDuration * 3 * baseScale),
    );
  });

  // Apple TS I-frame ranges: they start past the program tables and cut into
  // the neighbouring frames, a stub after the key frame in one and before it
  // in the other.
  for (const [head, range, start, slot] of [
    ['apple-ts-iframe-head.m2ts', 'apple-ts-iframe-range.m2ts', 2, 2],
    ['apple-ts-iframe-head-2.m2ts', 'apple-ts-iframe-range-2.m2ts', 5.005, 5.005],
  ] as const) {
    it(`${range}: tables from the file start, then one key frame for the slot`, () => {
      const tables = programTables(segment(head));
      expect(tables?.byteLength).toBe(376);
      expect(programTables(segment(range))).toBeNull();
      const muxed = transmux(concat(tables as Uint8Array, segment(range)), start, false, 'video');
      if (muxed.bytes === null) throw new Error('transmux produced nothing');
      const moof = findBox(muxed.bytes, 'moof');
      const fitted = fitFragment(muxed.bytes, timescaleOf(muxed.bytes), slot);
      if (fitted === null || moof === null) throw new Error('expected a rebuilt fragment');
      const samples = fragmentSamples(fitted)[0]?.samples ?? [];
      expect(samples).toHaveLength(1);
      expect(samples[0]?.isKeyframe).toBe(true);
      // The key frame lasts from where it starts to the end of the slot.
      const slotStart = fragmentSamples(muxed.bytes)[0]?.samples[0]?.decodeTime ?? 0;
      const key = samples[0];
      if (key === undefined) throw new Error('no key frame');
      expect(key.decodeTime + key.duration).toBe(slotStart + Math.round(slot * 90000));
    });
  }
});

describe('decoder configuration for WebCodecs', () => {
  it('reads the avcC of an init segment', () => {
    const config = decoderConfigBox(segment('apple-iframe-init.mp4'));
    expect(config?.format).toBe('avc1');
    // AVCDecoderConfigurationRecord: configurationVersion 1, then the profile.
    expect(config?.description[0]).toBe(1);
  });

  it('is null for an audio init', () => {
    expect(decoderConfigBox(segment('init-a.mp4'))).toBeNull();
  });
});
