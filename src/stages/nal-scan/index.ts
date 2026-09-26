/**
 * nal-scan reaches in-band captions in fMP4. On native CMAF content there is
 * no transmux walking the NALs, so this stage does: it learns the H.264 and
 * HEVC video tracks from the init segment, walks every moof, traf, and trun
 * of a media segment, finds the SEI NAL units in each sample, and delivers
 * their caption bytes to the same seam ts-transmux uses. It imports mp4-box
 * for the box reads and the shared SEI decoder; it never imports text-cea608.
 *
 * Samples hold length-prefixed NAL units (ISO/IEC 14496-15 §5.3.2), so the
 * walk jumps from one NAL header to the next and costs per NAL, not per byte.
 * Only SEI units are copied and decoded. It does no work when no caption
 * consumer is registered.
 */
import type { CcPacket } from '../../containers/captions.js';
import { captionsWanted, deliverCaptions } from '../../containers/captions.js';
import type { SampleDefaults } from '../../containers/mp4-box/index.js';
import {
  findBox,
  findBoxes,
  fourcc,
  fragmentSamples,
  sampleEntries,
  trackInfo,
  trexDefaults,
  VISUAL_ENTRY_HEADER,
} from '../../containers/mp4-box/index.js';
import { type CcTriple, ccTriplesFromSei } from '../../containers/sei.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

/**
 * After aes-128 decryption (1), before ts-transmux (100). An MPEG-TS segment
 * has no moof at this point and is skipped, because the transmuxer delivers
 * its own captions.
 */
const SCAN_ORDER = 50;

/** H.264 SEI. ITU-T H.264 Table 7-1. */
const AVC_SEI = 6;
/** HEVC prefix and suffix SEI. ITU-T H.265 Table 7-1. */
const HEVC_PREFIX_SEI = 39;
const HEVC_SUFFIX_SEI = 40;

interface VideoTrack {
  readonly timescale: number;
  readonly hevc: boolean;
  /** NAL unit length prefix in bytes, from avcC or hvcC. */
  readonly lengthSize: number;
}

/** The H.264 and HEVC tracks of an init segment, by track ID. Other codecs carry no SEI. */
function videoTracks(init: Uint8Array): Map<number, VideoTrack> {
  const tracks = new Map<number, VideoTrack>();
  for (const trak of findBoxes(init, 'moov/trak')) {
    const info = trackInfo(trak.payload);
    const stsd = findBox(trak.payload, 'mdia/minf/stbl/stsd');
    const entry = stsd === null ? undefined : sampleEntries(stsd.payload)[0];
    if (info === null || entry === undefined) continue;
    if (entry.body.byteLength < VISUAL_ENTRY_HEADER) continue;
    const children = entry.body.subarray(VISUAL_ENTRY_HEADER);

    let format = entry.format;
    if (format === 'encv') {
      // The original format is in sinf/frma (ISO/IEC 23001-7 §4.1). Subsample
      // encryption leaves SEI units in the clear, so protected video scans too.
      const sinf = findBox(children, 'sinf');
      const frma = sinf === null ? null : findBox(sinf.payload, 'frma');
      if (frma === null || frma.payload.byteLength < 4) continue;
      format = fourcc(frma.payload, 0);
    }
    const hevc = format === 'hvc1' || format === 'hev1';
    if (!hevc && format !== 'avc1' && format !== 'avc3') continue;

    // lengthSizeMinusOne is the low two bits of avcC byte 4 and hvcC byte 21.
    const config = findBox(children, hevc ? 'hvcC' : 'avcC');
    const lengthAt = hevc ? 21 : 4;
    const lengthSize =
      config !== null && config.payload.byteLength > lengthAt
        ? ((config.payload[lengthAt] as number) & 0x03) + 1
        : 4;

    const { trackId, timescale } = info;
    if (timescale === 0) continue;
    tracks.set(trackId, { timescale, hevc, lengthSize });
  }
  return tracks;
}

/** Appends the SEI NAL units of one sample to `out`. */
function seiUnits(sample: Uint8Array, track: VideoTrack, out: Uint8Array[]): void {
  let offset = 0;
  while (offset + track.lengthSize <= sample.byteLength) {
    let length = 0;
    for (let i = 0; i < track.lengthSize; i += 1) {
      length = length * 256 + (sample[offset + i] as number);
    }
    offset += track.lengthSize;
    if (length === 0 || offset + length > sample.byteLength) return;
    const header = sample[offset] as number;
    const hevcType = (header >> 1) & 0x3f;
    const sei = track.hevc
      ? hevcType === HEVC_PREFIX_SEI || hevcType === HEVC_SUFFIX_SEI
      : (header & 0x1f) === AVC_SEI;
    if (sei) out.push(sample.subarray(offset, offset + length));
    offset += length;
  }
}

/**
 * The caption packets of one media segment. A sample's time is the segment's
 * presentation start plus its presentation offset from the first decode time
 * of its track in the segment, the timeline cmaf-timing and the transmuxer
 * produce. The tfdt itself may carry a broadcast clock.
 */
function captionPackets(
  data: Uint8Array,
  tracks: ReadonlyMap<number, VideoTrack>,
  defaults: ReadonlyMap<number, SampleDefaults>,
  start: number,
): CcPacket[] {
  const packets: CcPacket[] = [];
  const firstDecode = new Map<number, number>();
  for (const traf of fragmentSamples(data, defaults)) {
    const track = tracks.get(traf.trackId);
    const first = firstDecode.get(traf.trackId) ?? traf.samples[0]?.decodeTime ?? 0;
    firstDecode.set(traf.trackId, first);
    if (track === undefined) continue;
    for (const sample of traf.samples) {
      const units: Uint8Array[] = [];
      seiUnits(data.subarray(sample.offset, sample.offset + sample.size), track, units);
      const triples: CcTriple[] = [];
      for (const unit of units) triples.push(...ccTriplesFromSei(unit, track.hevc ? 2 : 1));
      if (triples.length > 0) {
        packets.push({
          time: start + (sample.decodeTime - first + sample.cts) / track.timescale,
          triples,
        });
      }
    }
  }
  return packets;
}

export default function nalScan(): Stage {
  // The caption-bearing video tracks of the latest init segment, by track ID.
  let tracks: ReadonlyMap<number, VideoTrack> = new Map();
  // The trex defaults of the same init, for fragments that leave them out.
  let defaults: ReadonlyMap<number, SampleDefaults> = new Map();

  return {
    name: 'nal-scan',
    provides: ['nal-scan'],
    install(ctx) {
      ctx.registerTransform({
        name: 'nal-scan',
        order: SCAN_ORDER,
        transform(data: Uint8Array, meta: SegmentMeta): Uint8Array {
          // No work without a caption consumer. Audio buffers carry no video SEI.
          if (!captionsWanted() || meta.contentType !== 'video') return data;
          try {
            if (findBox(data, 'moov') !== null) {
              tracks = videoTracks(data);
              defaults = trexDefaults(data);
            }
            if (tracks.size > 0) {
              deliverCaptions(captionPackets(data, tracks, defaults, meta.start));
            }
          } catch {
            // A malformed fragment yields no captions. The bytes still append,
            // and MSE reports real corruption.
          }
          return data;
        },
      });
    },
  };
}
