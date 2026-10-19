/**
 * H.265 Annex B to the hvc1 sample format. The NAL units split on start
 * codes as in H.264 (splitNalUnits applies); the header is two bytes and
 * the type sits in bits 1 to 6 of the first (ITU-T H.265 §7.3.1.2). The
 * parameter sets (VPS, SPS, PPS) move into the hvcC box and out of the
 * samples, which hls.js does as well. An IRAP picture (BLA, IDR or CRA,
 * types 16 to 21, H.265 §7.4.2.2) is a sync sample.
 */

import { toRbsp } from '../sei.js';
import type { AccessUnit } from './h264.js';

export const HEVC_NAL_TYPE = {
  irapFirst: 16,
  irapLast: 21,
  vps: 32,
  sps: 33,
  pps: 34,
  accessUnitDelimiter: 35,
  prefixSei: 39,
  suffixSei: 40,
} as const;

export function hevcNalType(nal: Uint8Array): number {
  return ((nal[0] ?? 0) >> 1) & 0x3f;
}

/** An HEVC access unit: the samples' NALs, and the parameter sets it carried. */
export interface HevcAccessUnit extends AccessUnit {
  readonly vps: Uint8Array | null;
}

/** Builds one hvc1 sample from an access unit's NAL units, as the H.264 path does. */
export function hevcAccessUnitFromNals(nals: readonly Uint8Array[]): HevcAccessUnit {
  let vps: Uint8Array | null = null;
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let isKeyframe = false;
  const sampleNals: Uint8Array[] = [];
  const sei: Uint8Array[] = [];
  for (const nal of nals) {
    const type = hevcNalType(nal);
    if (type === HEVC_NAL_TYPE.vps) vps = nal;
    else if (type === HEVC_NAL_TYPE.sps) sps = nal;
    else if (type === HEVC_NAL_TYPE.pps) pps = nal;
    else if (type === HEVC_NAL_TYPE.accessUnitDelimiter) continue;
    else {
      if (type >= HEVC_NAL_TYPE.irapFirst && type <= HEVC_NAL_TYPE.irapLast) isKeyframe = true;
      if (type === HEVC_NAL_TYPE.prefixSei) sei.push(nal);
      sampleNals.push(nal);
    }
  }
  let length = 0;
  for (const nal of sampleNals) length += 4 + nal.byteLength;
  const avcc = new Uint8Array(length);
  const view = new DataView(avcc.buffer);
  let offset = 0;
  for (const nal of sampleNals) {
    view.setUint32(offset, nal.byteLength);
    avcc.set(nal, offset + 4);
    offset += 4 + nal.byteLength;
  }
  return { avcc, isKeyframe, vps, sps, pps, sei };
}

/** Reads bits MSB first; reads past the end return zeroes, so a truncated SPS cannot loop. */
class Bits {
  private position = 0;
  constructor(private readonly data: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = this.data[this.position >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (this.position & 7))) & 1);
      this.position += 1;
    }
    return value;
  }

  skip(count: number): void {
    this.position += count;
  }

  /** Unsigned Exp-Golomb (H.265 §9.2), bounded at 32 leading zeroes. */
  ue(): number {
    let zeros = 0;
    while (zeros < 32 && this.position < this.data.byteLength * 8 && this.read(1) === 0) {
      zeros += 1;
    }
    return 2 ** zeros - 1 + this.read(zeros);
  }
}

/** What the hvcC box and the sample entry need from an SPS. */
export interface HevcSpsInfo {
  readonly width: number;
  readonly height: number;
  readonly chromaFormat: number;
  readonly bitDepthLuma: number;
  readonly bitDepthChroma: number;
  /** sps_max_sub_layers_minus1 + 1. */
  readonly temporalLayers: number;
  readonly temporalIdNested: boolean;
  /**
   * general_profile_space through general_level_idc, 12 bytes as the SPS
   * carries them (H.265 §7.3.3), which hvcC repeats in the same order.
   */
  readonly profileTierLevel: Uint8Array;
}

/** Parses the fields of an SPS (H.265 §7.3.2.2.1) up to the bit depths. */
export function hevcSpsInfo(sps: Uint8Array): HevcSpsInfo {
  const rbsp = toRbsp(sps, 2);
  const bits = new Bits(rbsp);
  bits.skip(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = bits.read(3);
  const temporalIdNested = bits.read(1) === 1;
  const profileTierLevel = rbsp.slice(1, 13);
  bits.skip(96); // the general profile, tier, constraints and level
  // H.265 §7.3.3: the sub-layer flags, then the sub-layer fields they enable.
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    profilePresent.push(bits.read(1) === 1);
    levelPresent.push(bits.read(1) === 1);
  }
  if (maxSubLayersMinus1 > 0) bits.skip(2 * (8 - maxSubLayersMinus1));
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    if (profilePresent[i]) bits.skip(88);
    if (levelPresent[i]) bits.skip(8);
  }
  bits.ue(); // sps_seq_parameter_set_id
  const chromaFormat = bits.ue();
  if (chromaFormat === 3) bits.skip(1); // separate_colour_plane_flag
  let width = bits.ue();
  let height = bits.ue();
  if (bits.read(1) === 1) {
    // The conformance window, in chroma units (H.265 Table 6-1).
    const subWidth = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const subHeight = chromaFormat === 1 ? 2 : 1;
    width -= subWidth * (bits.ue() + bits.ue());
    height -= subHeight * (bits.ue() + bits.ue());
  }
  const bitDepthLuma = bits.ue() + 8;
  const bitDepthChroma = bits.ue() + 8;
  return {
    width: Math.max(0, width),
    height: Math.max(0, height),
    chromaFormat,
    bitDepthLuma,
    bitDepthChroma,
    temporalLayers: maxSubLayersMinus1 + 1,
    temporalIdNested,
    profileTierLevel,
  };
}

/**
 * The HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 §8.3.3.1.2), with
 * one complete array each for the VPS, the SPS and the PPS, and 4-byte NAL
 * lengths.
 */
export function hevcDecoderConfiguration(
  vps: Uint8Array,
  sps: Uint8Array,
  pps: Uint8Array,
): Uint8Array {
  const info = hevcSpsInfo(sps);
  const arrays: Array<[number, Uint8Array]> = [
    [HEVC_NAL_TYPE.vps, vps],
    [HEVC_NAL_TYPE.sps, sps],
    [HEVC_NAL_TYPE.pps, pps],
  ];
  let length = 23;
  for (const [, nal] of arrays) length += 5 + nal.byteLength;
  const out = new Uint8Array(length);
  out[0] = 1; // configurationVersion
  out.set(info.profileTierLevel, 1);
  // reserved 1111, min_spatial_segmentation_idc 0
  out[13] = 0xf0;
  out[14] = 0x00;
  out[15] = 0xfc; // reserved 111111, parallelismType 0 (unknown)
  out[16] = 0xfc | (info.chromaFormat & 0x03);
  out[17] = 0xf8 | ((info.bitDepthLuma - 8) & 0x07);
  out[18] = 0xf8 | ((info.bitDepthChroma - 8) & 0x07);
  out[19] = 0; // avgFrameRate 0: unspecified
  out[20] = 0;
  // constantFrameRate 0, numTemporalLayers, temporalIdNested, lengthSizeMinusOne 3
  out[21] = ((info.temporalLayers & 0x07) << 3) | (info.temporalIdNested ? 0x04 : 0) | 0x03;
  out[22] = arrays.length;
  let offset = 23;
  for (const [type, nal] of arrays) {
    out[offset] = 0x80 | type; // array_completeness 1: no parameter set in the samples
    out[offset + 1] = 0;
    out[offset + 2] = 1;
    out[offset + 3] = nal.byteLength >> 8;
    out[offset + 4] = nal.byteLength & 0xff;
    out.set(nal, offset + 5);
    offset += 5 + nal.byteLength;
  }
  return out;
}
