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

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Walks one level plus known containers, depth-first. The visitor sees
 * every box; returning false stops the walk early without error.
 */
export function walkBoxes(
  data: Uint8Array,
  visit: (box: BoxRef) => boolean | undefined,
): WalkResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  function level(start: number, end: number, path: string): MatteboxError | null | 'stop' {
    let offset = start;
    while (offset < end) {
      if (end - offset < 8) {
        return malformed('truncated box header', offset);
      }
      let size = view.getUint32(offset);
      let headerSize = 8;
      const type = fourcc(view, offset + 4);
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
  const view = new DataView(header.body.buffer, header.body.byteOffset, header.body.byteLength);
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
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
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
export function trackTimescales(init: Uint8Array): Map<number, number> {
  const map = new Map<number, number>();
  for (const trak of findBoxes(init, 'moov/trak')) {
    const tkhd = findBox(trak.payload, 'tkhd');
    const mdhd = findBox(trak.payload, 'mdia/mdhd');
    if (tkhd === null || mdhd === null) continue;
    const tkView = new DataView(
      tkhd.payload.buffer,
      tkhd.payload.byteOffset,
      tkhd.payload.byteLength,
    );
    const mdView = new DataView(
      mdhd.payload.buffer,
      mdhd.payload.byteOffset,
      mdhd.payload.byteLength,
    );
    // FullBox: version(1) flags(3), then creation/modification times (4 or 8
    // bytes each by version), then the field of interest.
    const trackAt = tkhd.payload[0] === 1 ? 20 : 12;
    const scaleAt = mdhd.payload[0] === 1 ? 20 : 12;
    if (tkhd.payload.byteLength < trackAt + 4 || mdhd.payload.byteLength < scaleAt + 4) continue;
    const trackId = tkView.getUint32(trackAt);
    const timescale = mdView.getUint32(scaleAt);
    if (timescale > 0) map.set(trackId, timescale);
  }
  return map;
}

/**
 * Rewrites every traf's tfdt baseMediaDecodeTime in place so the segment's
 * media clock equals its presentation start. A CMAF live segment carries the
 * real broadcast clock (a huge value); appended with a zero timestampOffset it
 * would land far off the playhead. Normalizing it to `presentationStart` makes
 * the segment land exactly where the manifest places it, the same alignment a
 * TS transmux gives for free. Returns the number of tfdt boxes rewritten.
 */
export function normalizeTfdt(
  segment: Uint8Array,
  presentationStart: number,
  timescales: ReadonlyMap<number, number>,
  fallbackTimescale: number,
): number {
  let rewritten = 0;
  for (const traf of findBoxes(segment, 'moof/traf')) {
    const tfdt = findBox(traf.payload, 'tfdt');
    if (tfdt === null) continue;
    const tfhd = findBox(traf.payload, 'tfhd');
    // tfhd FullBox: version(1) flags(3), then track_ID(4).
    const trackId =
      tfhd !== null && tfhd.payload.byteLength >= 8
        ? new DataView(
            tfhd.payload.buffer,
            tfhd.payload.byteOffset,
            tfhd.payload.byteLength,
          ).getUint32(4)
        : null;
    const timescale = (trackId !== null ? timescales.get(trackId) : undefined) ?? fallbackTimescale;
    if (timescale <= 0) continue;
    const target = Math.round(presentationStart * timescale);
    const body = tfdt.payload;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (body[0] === 1) {
      if (body.byteLength >= 12) view.setBigUint64(4, BigInt(target));
    } else {
      if (body.byteLength >= 8) view.setUint32(4, target);
    }
    rewritten += 1;
  }
  return rewritten;
}
