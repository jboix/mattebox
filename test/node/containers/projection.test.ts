import { describe, expect, it } from 'vitest';
import { readProjection } from '../../../src/containers/projection.js';

/** A box: a 32-bit size, the fourcc, then the payload. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const part of payload) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A FullBox: version 0, no flags, then the body. */
function full(type: string, ...body: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array(4), ...body);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (const [index, value] of values.entries()) view.setUint32(index * 4, value);
  return out;
}

/**
 * An init segment with one track of `handler`, whose sample entry `format`
 * carries `children` after the 78 bytes of a visual sample entry.
 */
function init(children: Uint8Array[], handler = 'vide', format = 'avc1'): Uint8Array {
  const entry = box(format, new Uint8Array(78), ...children);
  const stsd = full('stsd', u32(1), entry);
  const hdlr = full('hdlr', u32(0), ascii(handler), new Uint8Array(13));
  const minf = box('minf', box('stbl', stsd));
  return box('moov', box('trak', box('mdia', hdlr, minf)));
}

/** Apple's vexu/proj/prji with `kind`. */
function apple(kind: string): Uint8Array {
  return box('vexu', box('proj', full('prji', ascii(kind))));
}

/** Google's sv3d/proj with prhd and equi of these bounds. */
function google(top: number, bottom: number, left: number, right: number): Uint8Array {
  const prhd = full('prhd', u32(0, 0, 0));
  return box(
    'sv3d',
    full('svhd', ascii('test\0')),
    box('proj', prhd, full('equi', u32(top, bottom, left, right))),
  );
}

const QUARTER = 0x40000000;

describe('readProjection', () => {
  it("reads Apple's projection kind", () => {
    expect(readProjection(init([apple('equi')]))).toBe('equirectangular');
    expect(readProjection(init([apple('hequ')]))).toBe('half-equirectangular');
    expect(readProjection(init([apple('rect')]))).toBeNull();
    expect(readProjection(init([apple('fish')]))).toBeNull();
  });

  it("reads Google's equirectangular bounds: the whole sphere, or its front half", () => {
    expect(readProjection(init([google(0, 0, 0, 0)]))).toBe('equirectangular');
    expect(readProjection(init([google(0, 0, QUARTER, QUARTER)]))).toBe('half-equirectangular');
    // Cropped another way: no projection the IR names.
    expect(readProjection(init([google(QUARTER, 0, 0, 0)]))).toBeNull();
    expect(readProjection(init([google(0, 0, QUARTER, 0)]))).toBeNull();
  });

  it("does not take Google's cube map for an equirectangular picture", () => {
    const cube = box('sv3d', box('proj', full('prhd', u32(0, 0, 0)), full('cbmp', u32(0, 0))));
    expect(readProjection(init([cube]))).toBeNull();
  });

  it('reads the boxes beside the codec configuration, and in an encrypted entry', () => {
    const avcC = box('avcC', new Uint8Array([1, 0x64, 0, 0x28]));
    expect(readProjection(init([avcC, apple('equi')]))).toBe('equirectangular');
    expect(readProjection(init([avcC, box('sinf'), google(0, 0, 0, 0)], 'vide', 'encv'))).toBe(
      'equirectangular',
    );
  });

  it('is null for a flat picture, an audio track, and bytes that are not an init segment', () => {
    expect(readProjection(init([box('avcC', new Uint8Array(4))]))).toBeNull();
    expect(readProjection(init([apple('equi')], 'soun'))).toBeNull();
    expect(readProjection(new Uint8Array([0, 0, 0, 99, 1, 2]))).toBeNull();
    expect(readProjection(init([full('prji', ascii('equi'))]))).toBeNull();
  });
});
