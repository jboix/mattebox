import { describe, expect, it } from 'vitest';
import { readEmsg } from '../../../src/containers/emsg.js';

const ascii = (text: string) => [...new TextEncoder().encode(text)];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...ascii(type), ...body];

describe('the emsg reader', () => {
  it('reads both versions and stops at the moof', () => {
    const v0 = box('emsg', [
      0,
      0,
      0,
      0,
      ...ascii('urn:a'),
      0,
      ...ascii('1'),
      0,
      ...u32(90000),
      ...u32(45000),
      ...u32(0xffffffff),
      ...u32(7),
      1,
      2,
    ]);
    // A 64-bit presentation_time above 2^32.
    const v1 = box('emsg', [
      1,
      0,
      0,
      0,
      ...u32(1000),
      ...u32(1),
      ...u32(5),
      ...u32(2000),
      ...u32(8),
      ...ascii('urn:b'),
      0,
      0,
      9,
    ]);
    const after = box('emsg', [0, 0, 0, 0, 0, 0, ...u32(1), ...u32(0), ...u32(0), ...u32(9)]);
    const boxes = readEmsg(
      Uint8Array.from([...box('styp', []), ...v0, ...v1, ...box('moof', []), ...after]),
    );
    expect(boxes.map((b) => ({ ...b, data: [...b.data] }))).toEqual([
      {
        version: 0,
        scheme: 'urn:a',
        value: '1',
        timescale: 90000,
        time: 45000,
        duration: null,
        id: 7,
        data: [1, 2],
      },
      {
        version: 1,
        scheme: 'urn:b',
        value: '',
        timescale: 1000,
        time: 2 ** 32 + 5,
        duration: 2000,
        id: 8,
        data: [9],
      },
    ]);
  });

  it('skips a box it cannot read and never throws on a cut segment', () => {
    const v0 = box('emsg', [
      0,
      0,
      0,
      0,
      ...ascii('urn:a'),
      0,
      ...ascii('1'),
      0,
      ...u32(1),
      ...u32(0),
      ...u32(0),
      ...u32(1),
    ]);
    expect(readEmsg(Uint8Array.from(box('emsg', [0, 0, 0, 0, ...ascii('no-null')])))).toEqual([]);
    for (let length = 0; length < v0.length; length += 1) {
      expect(() => readEmsg(Uint8Array.from(v0.slice(0, length)))).not.toThrow();
    }
  });
});
