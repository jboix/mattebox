/**
 * The transmux core: MPEG-TS bytes to a self-contained fragmented MP4. Each
 * call is independent and pure, so identical input plus identical
 * presentation start yields identical output, on the main thread or in the
 * Worker. A muxed segment produces one init with a video and an audio track
 * and one media fragment carrying both, so a single SourceBuffer decodes it.
 *
 * Segment timing maps the raw PES timestamps onto the presentation through
 * an anchor: one timestamp at one presentation time. Legacy TS streams begin
 * at an arbitrary PTS, so the first segment of a timeline sets the anchor at
 * its playlist start, and every later segment of every rendition is placed
 * from its own timestamps against that anchor. Audio and video renditions
 * whose segments do not start together keep the offset the encoder gave
 * them, as hls.js keeps it with one initPTS per discontinuity. Inside one
 * segment, the video and the audio each start at their own first timestamp.
 */

import { adtsFragment, parseAdts, SAMPLES_PER_FRAME } from '../adts.js';
import type { CcPacket } from '../captions.js';
import {
  type AudioTrackConfig,
  concat,
  type Sample,
  sequenceNumberFor,
  type TrackConfig,
  type TrackFragment,
  type VideoTrackConfig,
  writeInitSegment,
  writeMediaSegment,
} from '../fmp4/writer.js';
import { ccTriplesFromSei } from '../sei.js';
import { demux, STREAM_TYPE, unrollTimestamps } from './demux.js';
import {
  type AccessUnit,
  accessUnitFromNals,
  NAL_TYPE,
  nalType,
  splitNalUnits,
  spsDimensions,
  toAccessUnit,
} from './h264.js';
import {
  HEVC_NAL_TYPE,
  hevcAccessUnitFromNals,
  hevcDecoderConfiguration,
  hevcNalType,
  hevcSpsInfo,
} from './h265.js';

const VIDEO_TIMESCALE = 90000;
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;
/** Fallback duration for a lone trailing video sample: 30 fps in 90 kHz. */
const DEFAULT_FRAME_DURATION = 3000;

/**
 * Which elementary streams to keep. A variant that muxes audio into its
 * segments while the manifest also names a separate audio rendition would
 * otherwise hand the video SourceBuffer an audio track its mime type never
 * declared (Chrome refuses the append) and play that audio twice.
 */
export type TransmuxTracks = 'all' | 'video' | 'audio';

/**
 * The parameter sets of a rendition: SPS and PPS, and the VPS for HEVC. A
 * segment cut mid-GOP carries none of its own; it borrows the last ones its
 * rendition had, which the caller keeps between segments.
 */
export interface ParameterSets {
  readonly sps: Uint8Array;
  readonly pps: Uint8Array;
  readonly vps?: Uint8Array;
}

const PTS_WRAP = 2 ** 33;

export interface TransmuxResult {
  /** The fMP4 bytes, or null when the input was not a transport stream. */
  readonly bytes: Uint8Array | null;
  readonly notTransportStream: boolean;
  /** True when the stream was TS but carried nothing playable. */
  readonly empty: boolean;
  /** CEA-608/708 caption packets from the video SEI, when captions were requested. */
  readonly captions: readonly CcPacket[];
  /** The ID3 tags of the metadata stream, each at its presentation time. */
  readonly metadata: readonly TimedTag[];
  /** True when the input carried an audio stream the `tracks` selection left out. */
  readonly droppedAudio: boolean;
  /** The parameter sets the video track used, for the caller to carry to the next segment. */
  readonly parameterSets: ParameterSets | null;
  /** The anchor the segment was placed by, for the caller to keep for its timeline. */
  readonly anchor: TimeAnchor | null;
}

/**
 * A raw 90 kHz timestamp and the presentation time it sits at, in seconds.
 * The caller keeps it between segments of one timeline.
 */
export interface TimeAnchor {
  readonly pts: number;
  readonly time: number;
}

/** How to place a segment: the anchor of its timeline, if any, and how far it may drift from the playlist. */
export interface TransmuxTiming {
  readonly anchor: TimeAnchor | null;
  /**
   * Seconds a segment's anchored start may lie from its playlist start. A
   * segment past it had its clock jump without a discontinuity tag: it
   * sets a new anchor at its playlist start.
   */
  readonly tolerance: number;
}

/** Presentation time, in seconds, of a raw 90 kHz timestamp. */
type TimeOf = (timestamp: number) => number;

/** The signed distance from `from` to `to` on the 33-bit clock, in 90 kHz units. */
function wrapDelta(to: number, from: number): number {
  let delta = (to - from) % PTS_WRAP;
  if (delta > PTS_WRAP / 2) delta -= PTS_WRAP;
  else if (delta < -PTS_WRAP / 2) delta += PTS_WRAP;
  return delta;
}

function timeOfAnchor(anchor: TimeAnchor): TimeOf {
  return (timestamp) => anchor.time + wrapDelta(timestamp, anchor.pts) / VIDEO_TIMESCALE;
}

/** One PES payload of a metadata stream (one ID3 tag) and its presentation time. */
export interface TimedTag {
  readonly time: number;
  readonly bytes: Uint8Array;
}

/**
 * The metadata stream's tags on the presentation timeline, each at its own
 * PTS, across a 33-bit PTS wrap. The bytes are copied so a Worker posts only
 * the tag, not the segment it was cut from.
 */
function timedTags(streams: ReturnType<typeof demux>, timeOf: TimeOf): TimedTag[] {
  const tags: TimedTag[] = [];
  for (const packet of streams.id3) {
    if (packet.pts === null) continue;
    tags.push({ time: timeOf(packet.pts), bytes: packet.data.slice() });
  }
  return tags;
}

interface VideoResult {
  readonly config: VideoTrackConfig;
  readonly fragment: TrackFragment;
  readonly captions: CcPacket[];
  readonly parameterSets: ParameterSets;
}

interface FramedUnit {
  readonly unit: AccessUnit & { readonly vps?: Uint8Array | null };
  readonly pts: number | null;
  readonly dts: number | null;
}

/** How one video codec's NAL units read: their type, the delimiter, and the access unit. */
interface NalSyntax {
  readonly type: (nal: Uint8Array) => number;
  readonly delimiter: number;
  readonly unit: (nals: readonly Uint8Array[]) => FramedUnit['unit'];
  /** The SEI NAL header length, for the caption reader. */
  readonly seiHeader: number;
}

const AVC: NalSyntax = {
  type: nalType,
  delimiter: NAL_TYPE.accessUnitDelimiter,
  unit: accessUnitFromNals,
  seiHeader: 1,
};

const HEVC: NalSyntax = {
  type: hevcNalType,
  delimiter: HEVC_NAL_TYPE.accessUnitDelimiter,
  unit: hevcAccessUnitFromNals,
  seiHeader: 2,
};

/**
 * Reframes video access units. Access units do not align with PES packet
 * boundaries in the wild: a picture's tail spills into the next PES packet,
 * whose header carries the next picture's timestamps. So the elementary stream
 * is concatenated and split into units by access-unit delimiter, and each unit
 * takes the timestamps of the PES packet its delimiter falls in. A stream with
 * no delimiters falls back to one unit per PES, which is correct when the muxer
 * did align them.
 */
function frameAccessUnits(
  packets: ReturnType<typeof demux>['video'],
  syntax: NalSyntax,
): FramedUnit[] {
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
  const hasAud = nals.some((n) => syntax.type(n) === syntax.delimiter);
  if (!hasAud) {
    return packets.map((p) => ({
      unit: syntax === AVC ? toAccessUnit(p.data) : syntax.unit(splitNalUnits(p.data)),
      pts: p.pts,
      dts: p.dts,
    }));
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
    framed.push({ unit: syntax.unit(group), pts: b.pts, dts: b.dts });
    group = [];
  };
  for (const nal of nals) {
    if (syntax.type(nal) === syntax.delimiter && group.length > 0) flush();
    if (group.length === 0) groupOffset = nal.byteOffset - es.byteOffset;
    group.push(nal);
  }
  flush();
  return framed;
}

function buildVideo(
  packets: ReturnType<typeof demux>['video'],
  timeOf: TimeOf,
  wantCaptions: boolean,
  carried: ParameterSets | null,
): VideoResult | null {
  if (packets.length === 0) return null;
  const hevc = packets[0]?.streamType === STREAM_TYPE.h265;
  const syntax = hevc ? HEVC : AVC;
  const framed = frameAccessUnits(packets, syntax);
  const units = framed.map((f) => f.unit);
  let vps: Uint8Array | null = null;
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const unit of units) {
    if (unit.vps != null) vps = unit.vps;
    if (unit.sps !== null) sps = unit.sps;
    if (unit.pps !== null) pps = unit.pps;
  }
  // A segment cut mid-GOP carries no parameter sets: it borrows the ones its
  // rendition's previous segment had, which still describe the stream. Its
  // frames up to the next keyframe decode from that segment's references.
  // Without either there is no honest init segment and the segment drops.
  sps = sps ?? carried?.sps ?? null;
  pps = pps ?? carried?.pps ?? null;
  vps = vps ?? carried?.vps ?? null;
  if (sps === null || pps === null || (hevc && vps === null)) return null;

  const dts = unrollTimestamps(framed.map((f) => f.dts));
  const pts = unrollTimestamps(framed.map((f) => f.pts));
  // The first decode time sits where the anchor puts it; the rest keep their
  // distances. A decode time cannot be negative: video the anchor puts
  // before the presentation's start begins at it.
  const start = Math.max(0, timeOf(dts[0] ?? 0));
  const base = Math.round(start * VIDEO_TIMESCALE);
  // Captions ride the video SEI; each access unit's triples display at that
  // frame's presentation time, on the same timeline as the media.
  const captions: CcPacket[] = [];
  if (wantCaptions) {
    const firstPts = pts[0] ?? 0;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i] as (typeof units)[number];
      if (unit.sei.length === 0) continue;
      const triples = unit.sei.flatMap((nal) => ccTriplesFromSei(nal, syntax.seiHeader));
      if (triples.length === 0) continue;
      const time = start + ((pts[i] as number) - firstPts) / VIDEO_TIMESCALE;
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
  const { width, height } = hevc ? hevcSpsInfo(sps) : spsDimensions(sps);
  const config: VideoTrackConfig = {
    id: VIDEO_TRACK_ID,
    kind: 'video',
    timescale: VIDEO_TIMESCALE,
    sps,
    pps,
    width,
    height,
    ...(vps !== null ? { hvcC: hevcDecoderConfiguration(vps, sps, pps) } : {}),
  };
  return {
    config,
    fragment: { trackId: VIDEO_TRACK_ID, baseMediaDecodeTime: base, samples },
    captions,
    parameterSets: vps !== null ? { sps, pps, vps } : { sps, pps },
  };
}

interface AudioResult {
  readonly config: AudioTrackConfig;
  readonly fragment: TrackFragment;
}

function buildAudio(
  packets: ReturnType<typeof demux>['audio'],
  timeOf: TimeOf,
  presentationStart: number,
): AudioResult | null {
  if (packets.length === 0) return null;
  const adts = parseAdts(concat(...packets.map((p) => p.data)));
  if (adts.frames.length === 0) return null;
  // The first frame's PTS places the fragment; a PES without one keeps the playlist start.
  const first = packets[0]?.pts ?? null;
  const start = first === null ? presentationStart : timeOf(first);
  if (start >= 0) return adtsFragment(adts, AUDIO_TRACK_ID, start);
  // Audio the anchor puts before the presentation's start has nothing to
  // play against: its frames up to there are dropped, as hls.js drops them.
  const frame = SAMPLES_PER_FRAME / adts.sampleRate;
  const dropped = Math.ceil(-start / frame - 1e-9);
  if (dropped >= adts.frames.length) return null;
  return adtsFragment(
    { ...adts, frames: adts.frames.slice(dropped) },
    AUDIO_TRACK_ID,
    start + dropped * frame,
  );
}

/**
 * The anchor a segment is placed by: its timeline's, or a new one that puts
 * the segment's first timestamp at its playlist start, when the timeline
 * has none or the segment drifted past the tolerance.
 */
function anchorFor(
  reference: number | null,
  presentationStart: number,
  timing: TransmuxTiming | null,
): TimeAnchor | null {
  if (reference === null) return timing?.anchor ?? null;
  const fresh = { pts: reference, time: presentationStart };
  const kept = timing?.anchor ?? null;
  if (kept === null) return fresh;
  const drift = timeOfAnchor(kept)(reference) - presentationStart;
  return Math.abs(drift) > (timing as TransmuxTiming).tolerance ? fresh : kept;
}

/** The first timestamp of the field `key` among `packets`, or null when none carries one. */
function firstTimestamp(
  packets: ReadonlyArray<{ readonly pts: number | null; readonly dts: number | null }>,
  key: 'pts' | 'dts',
): number | null {
  for (const packet of packets) {
    const value = packet[key];
    if (value !== null) return value;
  }
  return null;
}

export function transmux(
  input: Uint8Array,
  presentationStart = 0,
  wantCaptions = false,
  tracks: TransmuxTracks = 'all',
  parameterSets: ParameterSets | null = null,
  timing: TransmuxTiming | null = null,
): TransmuxResult {
  const streams = demux(input);
  if (streams.notTransportStream) {
    return {
      bytes: null,
      notTransportStream: true,
      empty: false,
      captions: [],
      metadata: [],
      droppedAudio: false,
      parameterSets: null,
      anchor: timing?.anchor ?? null,
    };
  }
  // The segment's reference timestamp: the earlier of its first video DTS
  // and its first audio PTS, as hls.js takes its initPTS, so neither track
  // of a muxed segment starts before the other's playlist start.
  const videoFirst = tracks !== 'audio' ? firstTimestamp(streams.video, 'dts') : null;
  const audioFirst = tracks !== 'video' ? firstTimestamp(streams.audio, 'pts') : null;
  const reference =
    videoFirst === null
      ? audioFirst
      : audioFirst === null || wrapDelta(audioFirst, videoFirst) >= 0
        ? videoFirst
        : audioFirst;
  const anchor = anchorFor(reference, presentationStart, timing);
  const timeOf: TimeOf = anchor === null ? () => presentationStart : timeOfAnchor(anchor);
  const video =
    tracks === 'audio' ? null : buildVideo(streams.video, timeOf, wantCaptions, parameterSets);
  const audio = tracks === 'video' ? null : buildAudio(streams.audio, timeOf, presentationStart);
  const droppedAudio = tracks === 'video' && streams.audio.length > 0;
  if (video === null && audio === null) {
    return {
      bytes: null,
      notTransportStream: false,
      empty: true,
      captions: [],
      metadata: [],
      droppedAudio,
      parameterSets: null,
      anchor,
    };
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
  const init = writeInitSegment(configs);
  const media = writeMediaSegment(sequenceNumberFor(presentationStart), fragments);
  return {
    bytes: concat(init, media),
    notTransportStream: false,
    empty: false,
    captions: video?.captions ?? [],
    metadata: timedTags(streams, timeOf),
    droppedAudio,
    parameterSets: video?.parameterSets ?? null,
    anchor,
  };
}
