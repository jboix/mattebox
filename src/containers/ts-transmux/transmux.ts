/**
 * The transmux core: MPEG-TS bytes to a self-contained fragmented MP4. Each
 * call is independent and pure, so identical input plus identical
 * presentation start yields identical output, on the main thread or in the
 * Worker. A muxed segment produces one init with a video and an audio track
 * and one media fragment carrying both, so a single SourceBuffer decodes it.
 *
 * Segment timing is anchored to the playlist presentation start, not the raw
 * PES timestamps: legacy TS streams begin at an arbitrary PTS, and aligning
 * baseMediaDecodeTime to the playlist is what keeps the buffer where the
 * scheduler expects it. Sample durations still come from the PES timeline.
 */

import { parseAdts } from '../adts.js';
import type { CcPacket } from '../captions.js';
import {
  type AudioTrackConfig,
  type Sample,
  type TrackConfig,
  type TrackFragment,
  type VideoTrackConfig,
  writeInitSegment,
  writeMediaSegment,
} from '../fmp4/writer.js';
import { ccTriplesFromSei } from '../sei.js';
import { demux, unrollTimestamps } from './demux.js';
import {
  type AccessUnit,
  accessUnitFromNals,
  NAL_TYPE,
  nalType,
  splitNalUnits,
  spsDimensions,
  toAccessUnit,
} from './h264.js';

const VIDEO_TIMESCALE = 90000;
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;
/** Fallback duration for a lone trailing video sample: 30 fps in 90 kHz. */
const DEFAULT_FRAME_DURATION = 3000;

export interface TransmuxResult {
  /** The fMP4 bytes, or null when the input was not a transport stream. */
  readonly bytes: Uint8Array | null;
  readonly notTransportStream: boolean;
  /** True when the stream was TS but carried nothing playable. */
  readonly empty: boolean;
  /** CEA-608/708 caption packets from the video SEI, when captions were requested. */
  readonly captions: readonly CcPacket[];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

interface VideoResult {
  readonly config: VideoTrackConfig;
  readonly fragment: TrackFragment;
  readonly captions: CcPacket[];
}

interface FramedUnit {
  readonly unit: AccessUnit;
  readonly pts: number | null;
  readonly dts: number | null;
}

/**
 * Reframes video access units. Access units do not align with PES packet
 * boundaries in the wild: a picture's tail spills into the next PES packet,
 * whose header carries the next picture's timestamps. So the elementary stream
 * is concatenated and split into units by access-unit delimiter, and each unit
 * takes the timestamps of the PES packet its delimiter falls in. A stream with
 * no delimiters falls back to one unit per PES, which is correct when the muxer
 * did align them.
 */
function frameAccessUnits(packets: ReturnType<typeof demux>['video']): FramedUnit[] {
  let total = 0;
  for (const p of packets) total += p.data.byteLength;
  const es = new Uint8Array(total);
  const boundaries: { offset: number; pts: number | null; dts: number | null }[] = [];
  let offset = 0;
  for (const p of packets) {
    boundaries.push({ offset, pts: p.pts, dts: p.dts });
    es.set(p.data, offset);
    offset += p.data.byteLength;
  }

  const nals = splitNalUnits(es);
  const hasAud = nals.some((n) => nalType(n) === NAL_TYPE.accessUnitDelimiter);
  if (!hasAud) {
    return packets.map((p) => ({ unit: toAccessUnit(p.data), pts: p.pts, dts: p.dts }));
  }

  const framed: FramedUnit[] = [];
  let group: Uint8Array[] = [];
  let groupOffset = 0;
  let boundaryIndex = 0;
  const flush = () => {
    if (group.length === 0) return;
    // Advance to the PES packet whose payload contains this unit's delimiter.
    while (
      boundaryIndex + 1 < boundaries.length &&
      (boundaries[boundaryIndex + 1] as (typeof boundaries)[number]).offset <= groupOffset
    ) {
      boundaryIndex += 1;
    }
    const b = boundaries[boundaryIndex] as (typeof boundaries)[number];
    framed.push({ unit: accessUnitFromNals(group), pts: b.pts, dts: b.dts });
    group = [];
  };
  for (const nal of nals) {
    if (nalType(nal) === NAL_TYPE.accessUnitDelimiter && group.length > 0) flush();
    if (group.length === 0) groupOffset = nal.byteOffset - es.byteOffset;
    group.push(nal);
  }
  flush();
  return framed;
}

function buildVideo(
  packets: ReturnType<typeof demux>['video'],
  presentationStart: number,
  wantCaptions: boolean,
): VideoResult | null {
  if (packets.length === 0) return null;
  const framed = frameAccessUnits(packets);
  const units = framed.map((f) => f.unit);
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const unit of units) {
    if (unit.sps !== null) sps = unit.sps;
    if (unit.pps !== null) pps = unit.pps;
  }
  // No parameter sets means this segment opened mid-GOP; without them there
  // is no honest init segment. Legacy HLS keys segments to a keyframe, so
  // this is the dirty-stream path, registered for recovery.
  if (sps === null || pps === null) return null;

  const dts = unrollTimestamps(framed.map((f) => f.dts));
  const pts = unrollTimestamps(framed.map((f) => f.pts));
  const base = Math.round(presentationStart * VIDEO_TIMESCALE);
  // Captions ride the video SEI; each access unit's triples display at that
  // frame's presentation time, anchored to the playlist start like the media.
  const captions: CcPacket[] = [];
  if (wantCaptions) {
    const firstPts = pts[0] ?? 0;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i] as (typeof units)[number];
      if (unit.sei.length === 0) continue;
      const triples = unit.sei.flatMap((nal) => ccTriplesFromSei(nal));
      if (triples.length === 0) continue;
      const time = presentationStart + ((pts[i] as number) - firstPts) / VIDEO_TIMESCALE;
      captions.push({ time, triples });
    }
  }
  const samples: Sample[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const duration =
      i + 1 < units.length
        ? Math.max(0, (dts[i + 1] as number) - (dts[i] as number))
        : DEFAULT_FRAME_DURATION;
    samples.push({
      data: (units[i] as (typeof units)[number]).avcc,
      duration: duration || DEFAULT_FRAME_DURATION,
      // Composition time offset, PTS minus DTS. This is negative for a B-frame
      // that decodes after a frame it displays before; the trun is version 1,
      // whose cts field is signed, so the negative value is written and read
      // back correctly. Clamping it here collapses reordered frames onto one
      // presentation time and the decoder loses reference-frame state.
      cts: (pts[i] as number) - (dts[i] as number),
      isKeyframe: (units[i] as (typeof units)[number]).isKeyframe,
    });
  }
  const { width, height } = spsDimensions(sps);
  const config: VideoTrackConfig = {
    id: VIDEO_TRACK_ID,
    kind: 'video',
    timescale: VIDEO_TIMESCALE,
    sps,
    pps,
    width,
    height,
  };
  return {
    config,
    fragment: { trackId: VIDEO_TRACK_ID, baseMediaDecodeTime: base, samples },
    captions,
  };
}

interface AudioResult {
  readonly config: AudioTrackConfig;
  readonly fragment: TrackFragment;
}

function buildAudio(
  packets: ReturnType<typeof demux>['audio'],
  presentationStart: number,
): AudioResult | null {
  if (packets.length === 0) return null;
  const adts = parseAdts(concat(packets.map((p) => p.data)));
  if (adts.frames.length === 0) return null;
  const base = Math.round(presentationStart * adts.sampleRate);
  const samples: Sample[] = adts.frames.map((frame) => ({
    data: frame.data,
    duration: 1024,
    cts: 0,
    isKeyframe: true,
  }));
  const config: AudioTrackConfig = {
    id: AUDIO_TRACK_ID,
    kind: 'audio',
    timescale: adts.sampleRate,
    audioObjectType: adts.audioObjectType,
    samplingFrequencyIndex: adts.samplingFrequencyIndex,
    channelConfig: adts.channelConfig,
  };
  return { config, fragment: { trackId: AUDIO_TRACK_ID, baseMediaDecodeTime: base, samples } };
}

export function transmux(
  input: Uint8Array,
  presentationStart = 0,
  wantCaptions = false,
): TransmuxResult {
  const streams = demux(input);
  if (streams.notTransportStream) {
    return { bytes: null, notTransportStream: true, empty: false, captions: [] };
  }
  const video = buildVideo(streams.video, presentationStart, wantCaptions);
  const audio = buildAudio(streams.audio, presentationStart);
  if (video === null && audio === null) {
    return { bytes: null, notTransportStream: false, empty: true, captions: [] };
  }
  const configs: TrackConfig[] = [];
  const fragments: TrackFragment[] = [];
  if (video !== null) {
    configs.push(video.config);
    fragments.push(video.fragment);
  }
  if (audio !== null) {
    configs.push(audio.config);
    fragments.push(audio.fragment);
  }
  // The mfhd sequence number derives from the presentation start so it is
  // deterministic per segment and rises across a presentation.
  const sequenceNumber = Math.max(1, Math.round(presentationStart) + 1);
  const init = writeInitSegment(configs);
  const media = writeMediaSegment(sequenceNumber, fragments);
  return {
    bytes: concat([init, media]),
    notTransportStream: false,
    empty: false,
    captions: video?.captions ?? [],
  };
}
