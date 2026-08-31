/**
 * H.264 Annex B to AVCC. The elementary stream separates NAL units with
 * start codes; MSE wants them length-prefixed, with the parameter sets moved
 * into the avcC box instead of the sample data. This module splits NALs,
 * pulls the SPS and PPS, and reads the coded dimensions out of the SPS so
 * the init segment is honest. Exp-Golomb reads are bounded by the bitstream
 * length, so a truncated SPS yields zeroes rather than a runaway loop.
 */

export const NAL_TYPE = {
  nonIdrSlice: 1,
  idrSlice: 5,
  sei: 6,
  sps: 7,
  pps: 8,
  accessUnitDelimiter: 9,
} as const;

/** Splits an Annex B buffer into raw NAL units, start codes removed. */
export function splitNalUnits(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  const length = data.byteLength;
  let start = -1;
  let i = 0;
  while (i + 2 < length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start !== -1) nals.push(data.subarray(start, i));
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start !== -1 && start < length) nals.push(data.subarray(start, length));
  // NALs are kept whole between start codes. Trailing zero bytes are left in
  // place: a decoder stops at the rbsp_stop bit and ignores what follows, and
  // a slice's CABAC zero words are genuine content that must not be trimmed.
  // Over-trimming the last slice truncates the lower macroblock rows, which is
  // exactly how a multi-slice frame corrupts halfway down.
  return nals.filter((nal) => nal.byteLength > 0);
}

export function nalType(nal: Uint8Array): number {
  return (nal[0] ?? 0) & 0x1f;
}

export interface AccessUnit {
  /** The VCL and SEI NALs, length-prefixed into one AVCC buffer. */
  readonly avcc: Uint8Array;
  readonly isKeyframe: boolean;
  readonly sps: Uint8Array | null;
  readonly pps: Uint8Array | null;
  /** The SEI NALs, kept whole so the caption path can read their messages. */
  readonly sei: Uint8Array[];
}

/**
 * Turns one PES payload's NALs into an access unit. Parameter sets are
 * surfaced for the init segment and dropped from the sample; slices and SEI
 * become length-prefixed AVCC. An IDR slice marks the sample as a keyframe.
 */
export function toAccessUnit(annexB: Uint8Array): AccessUnit {
  return accessUnitFromNals(splitNalUnits(annexB));
}

/**
 * Builds one access unit from its already-split NAL units. Access units do not
 * align with PES packet boundaries in the wild, so the demux splits the whole
 * elementary stream and groups NALs into units by access-unit delimiter; this
 * turns one such group into an AVCC sample.
 */
export function accessUnitFromNals(nals: readonly Uint8Array[]): AccessUnit {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let isKeyframe = false;
  const sampleNals: Uint8Array[] = [];
  const sei: Uint8Array[] = [];
  for (const nal of nals) {
    const type = nalType(nal);
    if (type === NAL_TYPE.sps) sps = nal;
    else if (type === NAL_TYPE.pps) pps = nal;
    else if (type === NAL_TYPE.accessUnitDelimiter) continue;
    else {
      if (type === NAL_TYPE.idrSlice) isKeyframe = true;
      if (type === NAL_TYPE.sei) sei.push(nal);
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
  return { avcc, isKeyframe, sps, pps, sei };
}

/** Strips H.264 emulation-prevention bytes (00 00 03 -> 00 00) for RBSP reads. */
function toRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.byteLength);
  let count = 0;
  let zeros = 0;
  for (let i = 1; i < nal.byteLength; i += 1) {
    const byte = nal[i] as number;
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out[count] = byte;
    count += 1;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, count);
}

class BitReader {
  private byte = 0;
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}

  private readBit(): number {
    if (this.byte >= this.data.byteLength) return 0;
    const value = ((this.data[this.byte] as number) >> (7 - this.bit)) & 1;
    this.bit += 1;
    if (this.bit === 8) {
      this.bit = 0;
      this.byte += 1;
    }
    return value;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | this.readBit();
    return value >>> 0;
  }

  /** Unsigned Exp-Golomb, bounded so a malformed stream cannot loop forever. */
  readUe(): number {
    let leadingZeros = 0;
    while (leadingZeros < 32 && this.byte < this.data.byteLength && this.readBit() === 0) {
      leadingZeros += 1;
    }
    if (leadingZeros === 0) return 0;
    return (1 << leadingZeros) - 1 + this.readBits(leadingZeros);
  }

  readSe(): number {
    const value = this.readUe();
    return value & 1 ? (value + 1) >> 1 : -(value >> 1);
  }
}

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/** Reads coded width and height from an SPS NAL, cropping applied. */
export function spsDimensions(sps: Uint8Array): Dimensions {
  // toRbsp already drops the one-byte NAL header, so the RBSP begins at
  // profile_idc; reading from there directly keeps every field aligned.
  const reader = new BitReader(toRbsp(sps));
  const profileIdc = reader.readBits(8);
  reader.readBits(8); // constraint flags and reserved
  reader.readBits(8); // level_idc
  reader.readUe(); // seq_parameter_set_id
  let chromaFormat = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormat = reader.readUe();
    if (chromaFormat === 3) reader.readBits(1);
    reader.readUe(); // bit_depth_luma_minus8
    reader.readUe(); // bit_depth_chroma_minus8
    reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
    if (reader.readBits(1)) {
      // seq_scaling_matrix_present_flag; the lists are skipped, the loop is
      // bounded so a hostile flag cannot spin.
      const count = chromaFormat === 3 ? 12 : 8;
      for (let i = 0; i < count; i += 1) if (reader.readBits(1)) reader.readUe();
    }
  }
  reader.readUe(); // log2_max_frame_num_minus4
  const picOrderCntType = reader.readUe();
  if (picOrderCntType === 0) reader.readUe();
  else if (picOrderCntType === 1) {
    reader.readBits(1);
    reader.readSe();
    reader.readSe();
    const numRefFrames = reader.readUe();
    for (let i = 0; i < numRefFrames && i < 256; i += 1) reader.readSe();
  }
  reader.readUe(); // max_num_ref_frames
  reader.readBits(1); // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbs = reader.readUe() + 1;
  const picHeightInMapUnits = reader.readUe() + 1;
  const frameMbsOnly = reader.readBits(1);
  if (frameMbsOnly === 0) reader.readBits(1); // mb_adaptive_frame_field_flag
  reader.readBits(1); // direct_8x8_inference_flag
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.readBits(1)) {
    cropLeft = reader.readUe();
    cropRight = reader.readUe();
    cropTop = reader.readUe();
    cropBottom = reader.readUe();
  }
  const width = picWidthInMbs * 16 - (cropLeft + cropRight) * 2;
  const height = (2 - frameMbsOnly) * picHeightInMapUnits * 16 - (cropTop + cropBottom) * 2;
  return { width: Math.max(0, width), height: Math.max(0, height) };
}
