/**
 * Reads the two parts of a WebM file that a DASH `SegmentBase` names: the
 * initialization range (the EBML header, the Segment header, Info and
 * Tracks) and the index range (the Cues element). Together they give the
 * byte range and the time of each Cluster, which is one media segment.
 *
 * The arithmetic follows Shaka Player's WebM segment index parser
 * (https://github.com/shaka-project/shaka-player/blob/main/lib/dash/webm_segment_index_parser.js).
 * Element IDs and types come from the Matroska specification, RFC 9559
 * (https://www.rfc-editor.org/rfc/rfc9559), and the encoding from EBML,
 * RFC 8794 (https://www.rfc-editor.org/rfc/rfc8794).
 *
 * Plain functions over `Uint8Array`. Malformed input never throws and never
 * loops: a reader returns null instead.
 */
import type { ByteRange, Segment, SidxSegments } from '../../types/ir.js';

/** EBML header, RFC 8794 §11.2.1. */
const EBML_ID = 0x1a45dfa3;
/** Segment, RFC 9559 §5.1. */
const SEGMENT_ID = 0x18538067;
/** Info, RFC 9559 §5.1.2. */
const INFO_ID = 0x1549a966;
/** TimestampScale (formerly TimecodeScale), RFC 9559 §5.1.2.9. */
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
/** Duration, RFC 9559 §5.1.2.10. */
const DURATION_ID = 0x4489;
/** Cues, RFC 9559 §5.1.5. */
const CUES_ID = 0x1c53bb6b;
/** CuePoint, RFC 9559 §5.1.5.1. */
const CUE_POINT_ID = 0xbb;
/** CueTime, RFC 9559 §5.1.5.1.1. */
const CUE_TIME_ID = 0xb3;
/** CueTrackPositions, RFC 9559 §5.1.5.1.2. */
const CUE_TRACK_POSITIONS_ID = 0xb7;
/** CueClusterPosition, RFC 9559 §5.1.5.1.2.2. */
const CUE_CLUSTER_POSITION_ID = 0xf1;

/** The TimestampScale default: one tick is a millisecond. RFC 9559 §5.1.2.9. */
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

/** What the initialization range says about the file. Plain numbers, so it can sit in state. */
export interface WebmInit {
  /** Offset of the Segment's data from the start of the init bytes: Segment Position 0, RFC 9559 §16. */
  readonly segmentStart: number;
  /** The Segment's declared data size in bytes, or null when it is unknown (RFC 8794 §6.2). */
  readonly segmentSize: number | null;
  /** Seconds per Segment Tick: TimestampScale nanoseconds over 1e9. */
  readonly tickSeconds: number;
  /** The Info Duration in seconds, or null when the file states none. */
  readonly duration: number | null;
}

/** One CuePoint: its time in Segment Ticks and its Cluster's Segment Position. */
export interface CuePoint {
  readonly time: number;
  readonly position: number;
}

/** One element header: its ID, where its data starts and ends within the bytes read. */
interface Element {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  /** The declared data size, or null for an unknown size. */
  readonly size: number | null;
}

/**
 * Reads a variable-size integer at `at`, RFC 8794 §4. `marker` keeps the
 * length marker bit, as an Element ID does (§5); without it the value is
 * a data size. Returns null when the bytes end early or the first byte is
 * zero, which no valid VINT starts with.
 */
function readVint(
  bytes: Uint8Array,
  at: number,
  marker: boolean,
): { readonly value: number; readonly length: number; readonly unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while ((first & (0x80 >> (length - 1))) === 0) length += 1;
  if (at + length > bytes.byteLength) return null;
  let value = marker ? first : first & (0xff >> length);
  // All value bits set is the reserved unknown size, RFC 8794 §6.2.
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    const byte = bytes[at + i] as number;
    if (byte !== 0xff) unknown = false;
    // Multiplication, not a shift: a value can pass 32 bits.
    value = value * 256 + byte;
  }
  return { value, length, unknown: !marker && unknown };
}

/**
 * Reads the element header at `at`. Its data is clamped to `limit`, so a
 * Segment whose data runs past the bytes fetched still reads as far as
 * they go, as Shaka's EBML parser reads a partial element. An unknown
 * size extends to `limit`.
 */
function readElement(bytes: Uint8Array, at: number, limit: number): Element | null {
  const id = readVint(bytes, at, true);
  if (id === null) return null;
  const size = readVint(bytes, at + id.length, false);
  if (size === null) return null;
  const start = at + id.length + size.length;
  if (start > limit) return null;
  const declared = size.unknown ? null : size.value;
  const end = declared === null ? limit : Math.min(limit, start + declared);
  return { id: id.value, start, end, size: declared };
}

/** The child elements between `start` and `end`, in order. Stops at the first header it cannot read. */
function childrenOf(bytes: Uint8Array, start: number, end: number): Element[] {
  const found: Element[] = [];
  let at = start;
  while (at < end) {
    const element = readElement(bytes, at, end);
    // An empty element still advances by its header, so the loop ends.
    if (element === null) break;
    found.push(element);
    at = element.end;
  }
  return found;
}

/** An unsigned integer element, RFC 8794 §7.2: big-endian, zero to eight bytes. */
function readUint(bytes: Uint8Array, element: Element): number {
  let value = 0;
  for (let i = element.start; i < element.end; i += 1) value = value * 256 + (bytes[i] as number);
  return value;
}

/** A float element, RFC 8794 §7.3: zero, four or eight bytes, big-endian IEEE 754. */
function readFloat(bytes: Uint8Array, element: Element): number | null {
  const length = element.end - element.start;
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.start, length);
  if (length === 4) return view.getFloat32(0);
  if (length === 8) return view.getFloat64(0);
  return length === 0 ? 0 : null;
}

/**
 * Reads the initialization range: the EBML header, then the Segment
 * header and its Info. Null when the bytes do not start with an EBML
 * header followed by a Segment, or hold no Info.
 */
export function readInit(bytes: Uint8Array): WebmInit | null {
  const header = readElement(bytes, 0, bytes.byteLength);
  if (header === null || header.id !== EBML_ID) return null;
  const segment = readElement(bytes, header.end, bytes.byteLength);
  if (segment === null || segment.id !== SEGMENT_ID) return null;
  const info = childrenOf(bytes, segment.start, segment.end).find((e) => e.id === INFO_ID);
  if (info === undefined) return null;
  let scale = DEFAULT_TIMESTAMP_SCALE;
  let ticks: number | null = null;
  for (const element of childrenOf(bytes, info.start, info.end)) {
    if (element.id === TIMESTAMP_SCALE_ID) scale = readUint(bytes, element) || scale;
    else if (element.id === DURATION_ID) ticks = readFloat(bytes, element);
  }
  const tickSeconds = scale / 1e9;
  return {
    segmentStart: segment.start,
    segmentSize: segment.size,
    tickSeconds,
    duration: ticks === null ? null : ticks * tickSeconds,
  };
}

/**
 * Reads the Cues element at the start of the index range. Each CuePoint
 * gives its CueTime and the CueClusterPosition of its first
 * CueTrackPositions. A DASH Representation carries one track, so the
 * first is the one. Null when the bytes do not start with Cues.
 */
export function readCues(bytes: Uint8Array): CuePoint[] | null {
  const cues = readElement(bytes, 0, bytes.byteLength);
  if (cues === null || cues.id !== CUES_ID) return null;
  const points: CuePoint[] = [];
  for (const point of childrenOf(bytes, cues.start, cues.end)) {
    if (point.id !== CUE_POINT_ID) continue;
    let time: number | null = null;
    let position: number | null = null;
    for (const element of childrenOf(bytes, point.start, point.end)) {
      if (element.id === CUE_TIME_ID) {
        time = readUint(bytes, element);
      } else if (element.id === CUE_TRACK_POSITIONS_ID && position === null) {
        const cluster = childrenOf(bytes, element.start, element.end).find(
          (e) => e.id === CUE_CLUSTER_POSITION_ID,
        );
        if (cluster !== undefined) position = readUint(bytes, cluster);
      }
    }
    if (time !== null && position !== null) points.push({ time, position });
  }
  return points;
}

/**
 * Turns the cue points into byte-range segments, one per Cluster. A
 * segment runs from its Cluster to the byte before the next one. The last
 * ends where the Cues start when they follow it, else at the end of the
 * Segment when its size is known, else at the end of the file (an
 * open-ended range). Its duration runs to the Info Duration, as in Shaka
 * Player; without a Duration the index cannot place the last segment and
 * no segment is returned.
 *
 * Several CuePoints can name one Cluster (one per track, or a
 * CueRelativePosition inside it): only the first of them opens a segment.
 */
export function cuesToSegments(
  init: WebmInit,
  initRange: ByteRange,
  points: readonly CuePoint[],
  addressing: SidxSegments,
): Segment[] {
  if (init.duration === null) return [];
  // CueClusterPosition counts from the Segment's data, RFC 9559 §16.
  const base = initRange.start + init.segmentStart;
  const clusters: CuePoint[] = [];
  for (const point of points) {
    const previous = clusters[clusters.length - 1];
    if (previous !== undefined && point.position <= previous.position) continue;
    clusters.push(point);
  }
  const pto = addressing.presentationTimeOffset ?? 0;
  const indexStart = addressing.indexRange.start;
  const segments: Segment[] = [];
  for (let i = 0; i < clusters.length; i += 1) {
    const point = clusters[i] as CuePoint;
    const next = clusters[i + 1];
    const start = point.time * init.tickSeconds;
    const end = next === undefined ? init.duration : next.time * init.tickSeconds;
    const byteStart = base + point.position;
    let byteEnd: number;
    if (next !== undefined) byteEnd = base + next.position - 1;
    else if (indexStart > byteStart) byteEnd = indexStart - 1;
    else if (init.segmentSize !== null) byteEnd = base + init.segmentSize - 1;
    // RFC 9110 §14.1.2: `bytes=N-` reads to the end. The transport sends that for Infinity.
    else byteEnd = Number.POSITIVE_INFINITY;
    if (end <= start) continue;
    segments.push({
      seq: segments.length,
      start: start - pto,
      duration: end - start,
      url: addressing.url,
      byteRange: { start: byteStart, end: byteEnd },
    });
  }
  return segments;
}
