import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeInitSegment, reconcileCodecs } from '../../../src/containers/codec-probe/index.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/segments');

function probe(name: string) {
  return probeInitSegment(new Uint8Array(readFileSync(join(FIXTURES, name))));
}

describe('codec string derivation from real init segments', () => {
  const matrix: Array<[string, string, string]> = [
    ['init-v-base.mp4', 'avc1.42c01e', 'video'],
    ['init-v-main.mp4', 'avc1.4d401e', 'video'],
    ['init-v-high.mp4', 'avc1.64000d', 'video'],
    ['init-v-vp9.mp4', 'vp09.00.30.08', 'video'],
    ['init-a.mp4', 'mp4a.40.2', 'audio'],
    ['init-a-opus.mp4', 'opus', 'audio'],
    ['init-a-ac3.mp4', 'ac-3', 'audio'],
    ['init-a-ec3.mp4', 'ec-3', 'audio'],
  ];
  for (const [name, expected, kind] of matrix) {
    it(`${name} derives ${expected}`, () => {
      const result = probe(name);
      expect(result.error).toBeNull();
      expect(result.codecs).toEqual([expected]);
      expect(result.tracks[0]?.kind).toBe(kind);
      expect(result.mimeType).toBe(`${kind}/mp4; codecs="${expected}"`);
    });
  }

  it('derives the full HEVC form, better than the manifest ffmpeg wrote', () => {
    // ffmpeg's own MPD says only 'hvc1'; the probe reconstructs the exact
    // profile, compatibility, tier, level, and constraint fields.
    const main = probe('init-v-hevc.mp4');
    expect(main.codecs[0]).toMatch(/^hvc1\.1\.6\.L\d+\.(90|B0)/);

    const main10 = probe('init-v-hevc10.mp4');
    expect(main10.codecs[0]).toMatch(/^hvc1\.2\.4\.L\d+\./);
  });

  it('derives av01 with profile, level, tier, and bit depth', () => {
    const result = probe('init-v-av1.mp4');
    expect(result.codecs[0]).toMatch(/^av01\.0\.\d{2}M\.08$/);
  });

  it('an unknown sample entry yields a track with a null codec, not a lie', () => {
    // A hand-built stsd with a fake fourcc.
    const stsdBody = new Uint8Array([
      0,
      0,
      0,
      0, // fullbox
      0,
      0,
      0,
      1, // entry count
      0,
      0,
      0,
      16,
      0x78,
      0x78,
      0x78,
      0x78, // entry 'xxxx', 16 bytes
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const boxed = wrap(
      'moov',
      wrap('trak', wrap('mdia', wrap('minf', wrap('stbl', box('stsd', stsdBody))))),
    );
    const result = probeInitSegment(boxed);
    expect(result.tracks).toEqual([{ format: 'xxxx', codec: null, kind: 'unknown' }]);
    expect(result.mimeType).toBeNull();
  });

  it('a malformed buffer reports the walker error', () => {
    const result = probeInitSegment(new Uint8Array([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]));
    expect(result.error?.code).toBe('MEDIA_CONTAINER_INVALID');
  });
});

describe('reconciliation: the probe wins', () => {
  it('prefers the probed string and flags the mismatch', () => {
    const result = probe('init-v-base.mp4');
    const outcome = reconcileCodecs('video/mp4; codecs="avc1.999999"', result);
    expect(outcome.contentType).toBe('video/mp4; codecs="avc1.42c01e"');
    expect(outcome.mismatch).toBe(true);
  });

  it('agreement is not a mismatch, whatever the formatting', () => {
    const result = probe('init-v-base.mp4');
    const outcome = reconcileCodecs('video/mp4;   codecs="AVC1.42C01E"', result);
    expect(outcome.mismatch).toBe(false);
  });

  it('with nothing probed, the manifest string stands', () => {
    const empty = probeInitSegment(new Uint8Array(0));
    const outcome = reconcileCodecs('video/mp4; codecs="avc1.42c01e"', empty);
    expect(outcome.contentType).toBe('video/mp4; codecs="avc1.42c01e"');
    expect(outcome.mismatch).toBe(false);
  });
});

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  out.set(payload, 8);
  return out;
}

function wrap(type: string, inner: Uint8Array): Uint8Array {
  return box(type, inner);
}
