/**
 * nal-scan exists only to reach captions in fMP4. On native CMAF content
 * there is no transmux walking the NALs, so this stage does: it walks the
 * moof and mdat, finds the SEI NAL units in each coded sample, times them
 * from the fragment's tfdt and trun, and delivers the caption bytes to the
 * same seam ts-transmux uses. It imports mp4-box for the box reads and the
 * shared SEI decoder; it never imports text-cea608.
 *
 * It is not cheap and does not pretend to be: per entanglement #1 it loads
 * only when a caption stage needs an fMP4 SEI source, and it does zero work
 * when no caption consumer is registered.
 */
import { captionsWanted, deliverCaptions } from '../../containers/captions.js';
import { findBox, parseTfdt } from '../../containers/mp4-box/index.js';
import { ccTriplesFromSei } from '../../containers/sei.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

/** After transmux (100) so it can walk transmuxed TS output as well as native fMP4. */
const SCAN_ORDER = 150;
const DEFAULT_TIMESCALE = 90000;
const SEI_NAL_TYPE = 6;

interface TrunSample {
  readonly duration: number;
  readonly size: number;
}

/** Reads sample durations and sizes from a trun, honouring its flag layout. */
function parseTrun(payload: Uint8Array): { samples: TrunSample[]; defaultDuration: number } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = view.getUint32(0) & 0x00ffffff;
  const sampleCount = view.getUint32(4);
  let offset = 8;
  if (flags & 0x0001) offset += 4; // data_offset
  if (flags & 0x0004) offset += 4; // first_sample_flags
  const hasDuration = (flags & 0x0100) !== 0;
  const hasSize = (flags & 0x0200) !== 0;
  const hasFlags = (flags & 0x0400) !== 0;
  const hasCts = (flags & 0x0800) !== 0;
  const samples: TrunSample[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    let duration = 0;
    let size = 0;
    if (hasDuration) {
      duration = view.getUint32(offset);
      offset += 4;
    }
    if (hasSize) {
      size = view.getUint32(offset);
      offset += 4;
    }
    if (hasFlags) offset += 4;
    if (hasCts) offset += 4;
    if (offset > payload.byteLength) break;
    samples.push({ duration, size });
  }
  return { samples, defaultDuration: DEFAULT_TIMESCALE / 30 };
}

/** Walks one AVCC sample's length-prefixed NALs, collecting the SEI units. */
function seiOfSample(sample: Uint8Array): Uint8Array[] {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
  const sei: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= sample.byteLength) {
    const length = view.getUint32(offset);
    offset += 4;
    if (length === 0 || offset + length > sample.byteLength) break;
    const nal = sample.subarray(offset, offset + length);
    if (((nal[0] ?? 0) & 0x1f) === SEI_NAL_TYPE) sei.push(nal);
    offset += length;
  }
  return sei;
}

export default function nalScan(): Stage {
  // The video track timescale, learned from the init segment's mdhd and held
  // across the media segments that follow it.
  let timescale = DEFAULT_TIMESCALE;

  return {
    name: 'nal-scan',
    provides: ['nal-scan'],
    install(ctx) {
      ctx.registerTransform({
        name: 'nal-scan',
        order: SCAN_ORDER,
        transform(data: Uint8Array, _meta: SegmentMeta): Uint8Array {
          // Zero work unless a caption consumer is registered.
          if (!captionsWanted()) return data;

          // An init segment carries the timescale in the video track's mdhd.
          const mdhd = findBox(data, 'moov/trak/mdia/mdhd');
          if (mdhd !== null) {
            const view = new DataView(
              mdhd.payload.buffer,
              mdhd.payload.byteOffset,
              mdhd.payload.byteLength,
            );
            const version = view.getUint8(0);
            timescale = version === 1 ? view.getUint32(20) : view.getUint32(12);
          }

          const mdat = findBox(data, 'mdat');
          const trunBox = findBox(data, 'moof/traf/trun');
          if (mdat === null || trunBox === null) return data;
          const tfdtBox = findBox(data, 'moof/traf/tfdt');
          const base =
            tfdtBox !== null ? (parseTfdt(tfdtBox.payload)?.baseMediaDecodeTime ?? 0) : 0;
          const { samples } = parseTrun(trunBox.payload);

          const packets: { time: number; triples: ReturnType<typeof ccTriplesFromSei> }[] = [];
          let cursor = 0;
          let decodeTime = base;
          for (const sample of samples) {
            const bytes = mdat.payload.subarray(cursor, cursor + sample.size);
            cursor += sample.size;
            const time = decodeTime / (timescale || DEFAULT_TIMESCALE);
            decodeTime += sample.duration;
            for (const sei of seiOfSample(bytes)) {
              const triples = ccTriplesFromSei(sei);
              if (triples.length > 0) packets.push({ time, triples });
            }
          }
          deliverCaptions(packets);
          return data;
        },
      });
    },
  };
}
