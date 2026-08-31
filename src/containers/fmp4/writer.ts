/**
 * A minimal fragmented-ISOBMFF writer, the counterpart to mp4-box's reader.
 * It emits exactly the boxes MSE needs to accept a fragment: an init segment
 * (ftyp + a moov with one trak per elementary stream and an mvex) and a
 * media segment (moof + mdat). A muxed TS segment becomes one init with a
 * video trak and an audio trak, so a single SourceBuffer decodes both.
 * Nothing here reads the clock or a random source: identical samples in
 * produce identical bytes out, which is what the golden fixtures pin.
 *
 * ts-transmux and packed-audio both import this module. It is a shared
 * container utility, not a stage, so neither imports the other.
 */

/** An AVC video track, configured from the SPS/PPS the demux extracted. */
export interface VideoTrackConfig {
  readonly id: number;
  readonly kind: 'video';
  /** 90 kHz for MPEG-TS sources. */
  readonly timescale: number;
  /** The sequence parameter set, one raw NAL with no start code or length prefix. */
  readonly sps: Uint8Array;
  readonly pps: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** An AAC audio track, configured from an ADTS header or an AudioSpecificConfig. */
export interface AudioTrackConfig {
  readonly id: number;
  readonly kind: 'audio';
  /** The sampling frequency in Hz; also the track timescale. */
  readonly timescale: number;
  /** MPEG-4 Audio Object Type. AAC-LC is 2. */
  readonly audioObjectType: number;
  /** Index into the MPEG-4 sampling frequency table. */
  readonly samplingFrequencyIndex: number;
  readonly channelConfig: number;
}

export type TrackConfig = VideoTrackConfig | AudioTrackConfig;

/** One access unit: length-prefixed AVCC NALs for video, one raw AAC frame for audio. */
export interface Sample {
  readonly data: Uint8Array;
  /** Duration in track timescale units. */
  readonly duration: number;
  /** Composition-time offset for B-frame reordering; zero for audio. */
  readonly cts: number;
  readonly isKeyframe: boolean;
}

/** One track's samples for a media segment, timed from its own decode time. */
export interface TrackFragment {
  readonly trackId: number;
  readonly baseMediaDecodeTime: number;
  readonly samples: readonly Sample[];
}

// ---- box primitives -------------------------------------------------------

function fourcc(type: string): [number, number, number, number] {
  return [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
}

/** Concatenates children under a box header. Sizes are computed, never assumed. */
function box(type: string, ...children: readonly Uint8Array[]): Uint8Array {
  let length = 8;
  for (const child of children) length += child.byteLength;
  const out = new Uint8Array(length);
  new DataView(out.buffer).setUint32(0, length);
  out.set(fourcc(type), 4);
  let offset = 8;
  for (const child of children) {
    out.set(child, offset);
    offset += child.byteLength;
  }
  return out;
}

/** A FullBox: version byte plus 24-bit flags ahead of the payload. */
function fullBox(
  type: string,
  version: number,
  flags: number,
  ...children: readonly Uint8Array[]
): Uint8Array {
  const head = u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff);
  return box(type, head, ...children);
}

function u8(...values: readonly number[]): Uint8Array {
  return Uint8Array.from(values, (v) => v & 0xff);
}

function u16(value: number): Uint8Array {
  return u8((value >> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  return u8((value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

/** A 64-bit unsigned as two 32-bit halves; JS numbers hold this range exactly to 2^53. */
function u64(value: number): Uint8Array {
  return concat(u32(Math.floor(value / 0x1_0000_0000)), u32(value >>> 0));
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const UNITY_MATRIX = concat(
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x4000_0000),
);

// ---- init segment ---------------------------------------------------------

function ftyp(): Uint8Array {
  return box(
    'ftyp',
    u8(...fourcc('isom')),
    u32(0x200),
    u8(...fourcc('isom')),
    u8(...fourcc('iso6')),
    u8(...fourcc('mp41')),
  );
}

function avcC(config: VideoTrackConfig): Uint8Array {
  const { sps, pps } = config;
  return box(
    'avcC',
    u8(1, sps[1] ?? 0, sps[2] ?? 0, sps[3] ?? 0),
    // lengthSizeMinusOne: 0xFF -> reserved bits set, 4-byte NAL length.
    u8(0xff),
    // numOfSequenceParameterSets: reserved bits set, count 1.
    u8(0xe1),
    u16(sps.byteLength),
    sps,
    u8(1),
    u16(pps.byteLength),
    pps,
  );
}

function avc1(config: VideoTrackConfig): Uint8Array {
  return box(
    'avc1',
    u8(0, 0, 0, 0, 0, 0),
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(config.width),
    u16(config.height),
    u32(0x0048_0000),
    u32(0x0048_0000),
    u32(0),
    u16(1),
    new Uint8Array(32),
    u16(0x18),
    u16(0xffff),
    avcC(config),
  );
}

function esds(config: AudioTrackConfig): Uint8Array {
  const asc = u8(
    (config.audioObjectType << 3) | (config.samplingFrequencyIndex >> 1),
    ((config.samplingFrequencyIndex & 1) << 7) | (config.channelConfig << 3),
  );
  const dsi = concat(u8(0x05, asc.byteLength), asc);
  const dcd = concat(u8(0x04, 13 + dsi.byteLength, 0x40, 0x15), u8(0, 0, 0), u32(0), u32(0), dsi);
  const sl = u8(0x06, 0x01, 0x02);
  const es = concat(u8(0x03, 3 + dcd.byteLength + sl.byteLength, 0, 0, 0), dcd, sl);
  return fullBox('esds', 0, 0, es);
}

function mp4a(config: AudioTrackConfig): Uint8Array {
  return box(
    'mp4a',
    u8(0, 0, 0, 0, 0, 0),
    u16(1),
    u32(0),
    u32(0),
    u16(config.channelConfig),
    u16(16),
    u16(0),
    u16(0),
    u32((config.timescale << 16) >>> 0),
    esds(config),
  );
}

function stbl(config: TrackConfig): Uint8Array {
  const entry = config.kind === 'video' ? avc1(config) : mp4a(config);
  return box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  );
}

function minf(config: TrackConfig): Uint8Array {
  const header =
    config.kind === 'video'
      ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
      : fullBox('smhd', 0, 0, u16(0), u16(0));
  const dref = fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1));
  return box('minf', header, box('dinf', dref), stbl(config));
}

function hdlr(config: TrackConfig): Uint8Array {
  const handler = config.kind === 'video' ? 'vide' : 'soun';
  const name = config.kind === 'video' ? 'VideoHandler' : 'SoundHandler';
  return fullBox(
    'hdlr',
    0,
    0,
    u32(0),
    u8(...fourcc(handler)),
    u32(0),
    u32(0),
    u32(0),
    concat(u8(...[...name].map((c) => c.charCodeAt(0))), u8(0)),
  );
}

function mdia(config: TrackConfig): Uint8Array {
  const mdhd = fullBox(
    'mdhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(config.timescale),
    u32(0),
    u16(0x55c4),
    u16(0),
  );
  return box('mdia', mdhd, hdlr(config), minf(config));
}

function tkhd(config: TrackConfig): Uint8Array {
  const w = config.kind === 'video' ? config.width : 0;
  const h = config.kind === 'video' ? config.height : 0;
  return fullBox(
    'tkhd',
    0,
    0x7,
    u32(0),
    u32(0),
    u32(config.id),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u16(0),
    u16(0),
    u16(config.kind === 'audio' ? 0x0100 : 0),
    u16(0),
    UNITY_MATRIX,
    u32((w << 16) >>> 0),
    u32((h << 16) >>> 0),
  );
}

function trak(config: TrackConfig): Uint8Array {
  return box('trak', tkhd(config), mdia(config));
}

function mvhd(nextTrackId: number): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(90000),
    u32(0),
    u32(0x0001_0000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    UNITY_MATRIX,
    concat(u32(0), u32(0), u32(0), u32(0), u32(0), u32(0)),
    u32(nextTrackId),
  );
}

function mvex(configs: readonly TrackConfig[]): Uint8Array {
  const trexes = configs.map((config) =>
    fullBox('trex', 0, 0, u32(config.id), u32(1), u32(0), u32(0), u32(0)),
  );
  return box('mvex', ...trexes);
}

/** The init segment: ftyp then a moov describing every track. */
export function writeInitSegment(configs: readonly TrackConfig[]): Uint8Array {
  let maxId = 0;
  for (const config of configs) maxId = Math.max(maxId, config.id);
  const moov = box('moov', mvhd(maxId + 1), ...configs.map(trak), mvex(configs));
  return concat(ftyp(), moov);
}

// ---- media segment --------------------------------------------------------

const TRUN_FLAGS = 0x0001 | 0x0100 | 0x0200 | 0x0400 | 0x0800;
const TFHD_FLAGS = 0x020000; // default-base-is-moof

function sampleFlags(sample: Sample): number {
  return sample.isKeyframe ? 0x0200_0000 : (0x0001_0000 | 0x0100_0000) >>> 0;
}

function traf(fragment: TrackFragment, trunHead: Uint8Array): Uint8Array {
  const tfhd = fullBox('tfhd', 0, TFHD_FLAGS, u32(fragment.trackId));
  const tfdt = fullBox('tfdt', 1, 0, u64(fragment.baseMediaDecodeTime));
  const entries = new Uint8Array(fragment.samples.length * 16);
  const view = new DataView(entries.buffer);
  for (let i = 0; i < fragment.samples.length; i += 1) {
    const sample = fragment.samples[i] as Sample;
    const base = i * 16;
    view.setUint32(base, sample.duration);
    view.setUint32(base + 4, sample.data.byteLength);
    view.setUint32(base + 8, sampleFlags(sample));
    view.setUint32(base + 12, sample.cts);
  }
  const trun = fullBox('trun', 1, TRUN_FLAGS, trunHead, entries);
  return box('traf', tfhd, tfdt, trun);
}

/**
 * The moof/mdat pair for one or more track fragments. Each trun's data offset
 * is back-patched once the moof size is known, so the offsets are exact
 * regardless of how many tracks the fragment carries or how large the trafs
 * grew. The mdat interleaves tracks in the order given.
 */
export function writeMediaSegment(
  sequenceNumber: number,
  fragments: readonly TrackFragment[],
): Uint8Array {
  const mfhd = fullBox('mfhd', 0, 0, u32(sequenceNumber));
  // Build each traf with a placeholder data offset, then back-patch below.
  const trafs = fragments.map((fragment) =>
    traf(fragment, concat(u32(fragment.samples.length), u32(0))),
  );
  const moof = box('moof', mfhd, ...trafs);
  const moofView = new DataView(moof.buffer);

  // The mdat payload begins right after the moof. Each track's samples follow
  // the previous track's in the mdat, so its data offset is the moof size plus
  // the mdat header plus the running byte total ahead of it.
  let trafOffsetInMoof = 8 + mfhd.byteLength;
  let mdatCursor = moof.byteLength + 8;
  for (const [i, fragment] of fragments.entries()) {
    const thisTraf = trafs[i] as Uint8Array;
    // trun payload begins at: traf header(8) + tfhd + tfdt + trun header(8) + fullbox(4) + sample_count(4).
    const tfhdLen = 8 + 4 + 4;
    const tfdtLen = 8 + 4 + 8;
    const trunDataOffsetPos = trafOffsetInMoof + 8 + tfhdLen + tfdtLen + 8 + 4 + 4;
    moofView.setUint32(trunDataOffsetPos, mdatCursor);
    let fragmentBytes = 0;
    for (const sample of fragment.samples) fragmentBytes += sample.data.byteLength;
    mdatCursor += fragmentBytes;
    trafOffsetInMoof += thisTraf.byteLength;
  }

  let mdatLength = 0;
  for (const fragment of fragments) {
    for (const sample of fragment.samples) mdatLength += sample.data.byteLength;
  }
  const mdat = new Uint8Array(8 + mdatLength);
  new DataView(mdat.buffer).setUint32(0, mdat.byteLength);
  mdat.set(fourcc('mdat'), 4);
  let offset = 8;
  for (const fragment of fragments) {
    for (const sample of fragment.samples) {
      mdat.set(sample.data, offset);
      offset += sample.data.byteLength;
    }
  }

  return concat(moof, mdat);
}
