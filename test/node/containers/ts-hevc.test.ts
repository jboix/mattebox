import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { probeInitSegment } from '../../../src/containers/codec-probe/index.js';
import { findBox, fragmentSamples, trexDefaults } from '../../../src/containers/mp4-box/index.js';
import { demux, STREAM_TYPE } from '../../../src/containers/ts-transmux/demux.js';
import { splitNalUnits } from '../../../src/containers/ts-transmux/h264.js';
import {
  HEVC_NAL_TYPE,
  hevcAccessUnitFromNals,
  hevcDecoderConfiguration,
  hevcNalType,
  hevcSpsInfo,
} from '../../../src/containers/ts-transmux/h265.js';
import { transmux } from '../../../src/containers/ts-transmux/transmux.js';

// One second of 160x90 HEVC Main at 30 fps with B-frames, and AAC, muxed
// into MPEG-TS by ffmpeg (libx265, keyint 30, bframes 2).
const TS = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../fixtures/golden/hevc-muxed.m2ts', import.meta.url))),
);

function parameterSets(): { vps: Uint8Array; sps: Uint8Array; pps: Uint8Array } {
  const video = demux(TS).video;
  const nals = splitNalUnits(video[0]?.data ?? new Uint8Array());
  const find = (type: number) => nals.find((n) => hevcNalType(n) === type) as Uint8Array;
  return {
    vps: find(HEVC_NAL_TYPE.vps),
    sps: find(HEVC_NAL_TYPE.sps),
    pps: find(HEVC_NAL_TYPE.pps),
  };
}

describe('HEVC in MPEG-TS', () => {
  it('the demux routes stream type 0x24 as video', () => {
    const streams = demux(TS);
    expect(streams.video.length).toBeGreaterThan(0);
    expect(streams.video[0]?.streamType).toBe(STREAM_TYPE.h265);
    expect(streams.audio.length).toBeGreaterThan(0);
  });

  it('reads the SPS: size, chroma, bit depth and sub-layers', () => {
    const info = hevcSpsInfo(parameterSets().sps);
    expect(info).toMatchObject({
      width: 160,
      height: 90,
      chromaFormat: 1,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
      temporalLayers: 1,
      temporalIdNested: true,
    });
  });

  it('writes the hvcC header ffmpeg writes for the same stream', () => {
    const { vps, sps, pps } = parameterSets();
    const record = hevcDecoderConfiguration(vps, sps, pps);
    // ffmpeg -c copy -tag:v hvc1 of the fixture, the first 23 bytes of its hvcC.
    expect(Array.from(record.subarray(0, 23), (b) => b.toString(16).padStart(2, '0'))).toEqual(
      '01 01 60 00 00 00 90 00 00 00 00 00 1e f0 00 fc fd f8 f8 00 00 0f 03'.split(' '),
    );
    // Three complete arrays: VPS, SPS, PPS.
    expect(record[22]).toBe(3);
    expect(record[23]).toBe(0x80 | HEVC_NAL_TYPE.vps);
  });

  it('transmuxes to an hvc1 track whose codec string the probe reads', () => {
    const result = transmux(TS, 10, false, 'video');
    expect(result.bytes).not.toBeNull();
    const bytes = result.bytes as Uint8Array;
    expect(probeInitSegment(bytes).codecs).toEqual(['hvc1.1.6.L30.90']);
    expect(findBox(bytes, 'moov/trak/mdia/minf/stbl/stsd')).not.toBeNull();
    expect(result.parameterSets?.vps).toBeDefined();
  });

  it('keeps every frame, marks the IRAP picture as the sync sample and drops parameter sets', () => {
    const bytes = transmux(TS, 0, false, 'video').bytes as Uint8Array;
    const [fragment] = fragmentSamples(bytes, trexDefaults(bytes));
    const samples = fragment?.samples ?? [];
    expect(samples).toHaveLength(30);
    // keyint 30: the first picture is the only IRAP.
    expect(samples.map((s) => s.isKeyframe)).toEqual([true, ...Array(29).fill(false)]);
    for (const sample of samples) {
      let offset = sample.offset;
      while (offset < sample.offset + sample.size) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0);
        const type = hevcNalType(bytes.subarray(offset + 4));
        expect([HEVC_NAL_TYPE.vps, HEVC_NAL_TYPE.sps, HEVC_NAL_TYPE.pps]).not.toContain(type);
        offset += 4 + length;
      }
    }
  });

  it('muxes the audio into the same fragment', () => {
    const bytes = transmux(TS, 0).bytes as Uint8Array;
    expect(probeInitSegment(bytes).codecs).toEqual(['hvc1.1.6.L30.90', 'mp4a.40.2']);
  });

  it('hands back the parameter sets for the next segment of the rendition', () => {
    const result = transmux(TS, 0, false, 'video');
    expect(result.parameterSets).toEqual(parameterSets());
    // The parameter sets alone make no sample.
    const { vps, sps, pps } = parameterSets();
    expect(hevcAccessUnitFromNals([vps, sps, pps]).avcc.byteLength).toBe(0);
  });
});
