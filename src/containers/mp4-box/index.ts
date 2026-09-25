/**
 * A minimal ISOBMFF box walker, not a general library. It traverses the
 * box tree handing back offsets, sizes, and payload views, with typed
 * extraction only for the boxes that have a consumer today: tfdt for the
 * timeline and sidx for dash-segmentbase. Everything else goes through the
 * generic walker.
 *
 * Malformed input never throws and never loops: every walk either
 * strictly advances or stops with a MatteboxError value.
 */
import type { MatteboxError } from '../../types/error.js';

/** One box as seen by the walker. `payload` is a subarray view, never a copy. */
export interface BoxRef {
  readonly type: string;
  /** Absolute offset of the box start within the walked buffer. */
  readonly start: number;
  /** Total box size including the header. */
  readonly size: number;
  readonly headerSize: number;
  readonly payload: Uint8Array;
  /** Slash-joined ancestor chain, such as 'moov/trak/mdia'. */
  readonly path: string;
}

export interface WalkResult {
  readonly error: MatteboxError | null;
}

/** Container boxes the walker descends into. Only ancestors of consumed boxes. */
const CONTAINERS: ReadonlySet<string> = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'moof',
  'traf',
]);

function malformed(reason: string, offset: number): MatteboxError {
  return {
    category: 'media',
    code: 'MEDIA_CONTAINER_INVALID',
    fatal: false,
    recoverable: false,
    context: { reason, offset },
  };
}

/** A DataView over exactly these bytes, wherever they sit in their buffer. */
export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The four ASCII characters at `at`: a box type, a sample entry format, an ID3 frame id. */
export function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0,
  );
}

/** SampleEntry (8 bytes) plus VisualSampleEntry (70 bytes). ISO/IEC 14496-12 §12.1.3. */
export const VISUAL_ENTRY_HEADER = 78;

/**
 * Walks one level plus known containers, depth-first. The visitor sees
 * every box; returning false stops the walk early without error.
 */
export function walkBoxes(
  data: Uint8Array,
  visit: (box: BoxRef) => boolean | undefined,
): WalkResult {
  const view = viewOf(data);

  function level(start: number, end: number, path: string): MatteboxError | null | 'stop' {
    let offset = start;
    while (offset < end) {
      if (end - offset < 8) {
        return malformed('truncated box header', offset);
      }
      let size = view.getUint32(offset);
      let headerSize = 8;
      const type = fourcc(data, offset + 4);
      if (size === 1) {
        // 64-bit size follows the type.
        if (end - offset < 16) return malformed('truncated 64-bit size', offset);
        const big = view.getBigUint64(offset + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return malformed('size overflow', offset);
        size = Number(big);
        headerSize = 16;
      } else if (size === 0) {
        // Extends to the end of the enclosing space.
        size = end - offset;
      }
      if (size < headerSize) {
        // A size smaller than its own header cannot advance: stop rather
        // than loop.
        return malformed('box size smaller than header', offset);
      }
      if (offset + size > end) {
        return malformed('box extends past its container', offset);
      }
      const payload = data.subarray(offset + headerSize, offset + size);
      const box: BoxRef = { type, start: offset, size, headerSize, payload, path };
      if (visit(box) === false) return 'stop';
      if (CONTAINERS.has(type)) {
        const nested = level(
          offset + headerSize,
          offset + size,
          path === '' ? type : `${path}/${type}`,
        );
        if (nested !== null) return nested;
      }
      offset += size;
    }
    return null;
  }

  const outcome = level(0, data.byteLength, '');
  return { error: outcome === 'stop' || outcome === null ? null : outcome };
}

/** The first box matching a slash path such as 'moov/trak/mdia/minf/stbl/stsd'. */
export function findBox(data: Uint8Array, path: string): BoxRef | null {
  let found: BoxRef | null = null;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const leaf = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  walkBoxes(data, (box) => {
    if (box.path === parent && box.type === leaf) {
      found = box;
      return false;
    }
    return undefined;
  });
  return found;
}

/** Every box matching the path, in document order. trak repeats, for one. */
export function findBoxes(data: Uint8Array, path: string): readonly BoxRef[] {
  const out: BoxRef[] = [];
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const leaf = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  walkBoxes(data, (box) => {
    if (box.path === parent && box.type === leaf) out.push(box);
    return undefined;
  });
  return out;
}

export interface FullBoxHeader {
  readonly version: number;
  readonly flags: number;
  readonly body: Uint8Array;
}

/** Splits a FullBox payload into version, 24-bit flags, and the body view. */
export function fullBox(payload: Uint8Array): FullBoxHeader | null {
  if (payload.byteLength < 4) return null;
  const version = payload[0] as number;
  const flags =
    ((payload[1] as number) << 16) | ((payload[2] as number) << 8) | (payload[3] as number);
  return { version, flags, body: payload.subarray(4) };
}

export interface Tfdt {
  readonly version: number;
  readonly baseMediaDecodeTime: number;
}

/** tfdt: version 1 widens baseMediaDecodeTime to 64 bits. */
export function parseTfdt(payload: Uint8Array): Tfdt | null {
  const header = fullBox(payload);
  if (header === null) return null;
  const view = viewOf(header.body);
  if (header.version === 1) {
    if (header.body.byteLength < 8) return null;
    return { version: 1, baseMediaDecodeTime: Number(view.getBigUint64(0)) };
  }
  if (header.body.byteLength < 4) return null;
  return { version: 0, baseMediaDecodeTime: view.getUint32(0) };
}

export interface SidxReference {
  readonly referencedSize: number;
  readonly subsegmentDuration: number;
  readonly startsWithSap: boolean;
}

export interface Sidx {
  readonly version: number;
  readonly referenceId: number;
  readonly timescale: number;
  readonly earliestPresentationTime: number;
  readonly firstOffset: number;
  readonly references: readonly SidxReference[];
}

/** sidx: version 1 widens the time and offset fields to 64 bits. */
export function parseSidx(payload: Uint8Array): Sidx | null {
  const header = fullBox(payload);
  if (header === null) return null;
  const body = header.body;
  const view = viewOf(body);
  const wide = header.version === 1;
  const fixed = 8 + (wide ? 16 : 8) + 4;
  if (body.byteLength < fixed) return null;

  const referenceId = view.getUint32(0);
  const timescale = view.getUint32(4);
  let at = 8;
  const earliestPresentationTime = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
  at += wide ? 8 : 4;
  const firstOffset = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
  at += wide ? 8 : 4;
  at += 2; // reserved
  const count = view.getUint16(at);
  at += 2;
  if (body.byteLength < at + count * 12) return null;

  const references: SidxReference[] = [];
  for (let i = 0; i < count; i += 1) {
    const word = view.getUint32(at);
    references.push({
      referencedSize: word & 0x7fffffff,
      subsegmentDuration: view.getUint32(at + 4),
      startsWithSap: (view.getUint32(at + 8) & 0x80000000) !== 0,
    });
    at += 12;
  }
  return {
    version: header.version,
    referenceId,
    timescale,
    earliestPresentationTime,
    firstOffset,
    references,
  };
}

/**
 * The media timescale of each track, read from moov/trak (tkhd track id paired
 * with mdhd timescale). CMAF timing normalization needs it to convert a
 * baseMediaDecodeTime between timescale units and seconds.
 */
/** A trak's track_ID (tkhd) and media timescale (mdhd), or null when either is unreadable. */
export function trackInfo(trak: Uint8Array): { trackId: number; timescale: number } | null {
  const tkhd = findBox(trak, 'tkhd');
  const mdhd = findBox(trak, 'mdia/mdhd');
  if (tkhd === null || mdhd === null) return null;
  // FullBox: version(1) flags(3), then creation/modification times (4 or 8
  // bytes each by version), then the field of interest.
  const trackAt = tkhd.payload[0] === 1 ? 20 : 12;
  const scaleAt = mdhd.payload[0] === 1 ? 20 : 12;
  if (tkhd.payload.byteLength < trackAt + 4 || mdhd.payload.byteLength < scaleAt + 4) return null;
  return {
    trackId: viewOf(tkhd.payload).getUint32(trackAt),
    timescale: viewOf(mdhd.payload).getUint32(scaleAt),
  };
}

/** Every sample entry of an stsd payload: its format fourcc and the body after the 8-byte box header. */
export function sampleEntries(stsd: Uint8Array): Array<{ format: string; body: Uint8Array }> {
  const header = fullBox(stsd);
  if (header === null || header.body.byteLength < 4) return [];
  const body = header.body;
  const view = viewOf(body);
  const out: Array<{ format: string; body: Uint8Array }> = [];
  let at = 4;
  for (let i = 0; i < view.getUint32(0) && at + 8 <= body.byteLength; i += 1) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > body.byteLength) break;
    out.push({ format: fourcc(body, at + 4), body: body.subarray(at + 8, at + size) });
    at += size;
  }
  return out;
}

export function trackTimescales(init: Uint8Array): Map<number, number> {
  const map = new Map<number, number>();
  for (const trak of findBoxes(init, 'moov/trak')) {
    const info = trackInfo(trak.payload);
    if (info !== null && info.timescale > 0) map.set(info.trackId, info.timescale);
  }
  return map;
}

/**
 * The earliest tfdt baseMediaDecodeTime across the segment's track
 * fragments, in seconds of each track's own timescale, or null when no
 * fragment carries a readable one. A segment holds one fragment per track
 * or many (Apple packages about one per second inside a ten-second
 * segment); the earliest is where the bytes start, whatever clock the
 * packager wrote. A fragment whose track has no known timescale is
 * skipped rather than guessed. The same reading mux.js's `startTime` takes
 * for videojs-http-streaming.
 */
export function earliestDecodeTime(
  segment: Uint8Array,
  timescales: ReadonlyMap<number, number>,
): number | null {
  let earliest: number | null = null;
  for (const traf of findBoxes(segment, 'moof/traf')) {
    const tfdt = findBox(traf.payload, 'tfdt');
    const tfhd = findBox(traf.payload, 'tfhd');
    // tfhd FullBox: version(1) flags(3), then track_ID(4).
    if (tfdt === null || tfhd === null || tfhd.payload.byteLength < 8) continue;
    const trackId = viewOf(tfhd.payload).getUint32(4);
    const timescale = timescales.get(trackId);
    const parsed = parseTfdt(tfdt.payload);
    if (timescale === undefined || timescale <= 0 || parsed === null) continue;
    const seconds = parsed.baseMediaDecodeTime / timescale;
    if (earliest === null || seconds < earliest) earliest = seconds;
  }
  return earliest;
}
