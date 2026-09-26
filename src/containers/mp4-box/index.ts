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

// tfhd and trun flags. ISO/IEC 14496-12 §8.8.7 and §8.8.8.
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION = 0x000002;
const TFHD_DEFAULT_DURATION = 0x000008;
const TFHD_DEFAULT_SIZE = 0x000010;
const TFHD_DEFAULT_FLAGS = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_DURATION = 0x000100;
const TRUN_SIZE = 0x000200;
const TRUN_FLAGS = 0x000400;
const TRUN_CTS = 0x000800;

/** A track's sample defaults from an init segment's trex, for fragments that leave them out. */
export interface SampleDefaults {
  readonly duration: number;
  readonly size: number;
  readonly flags: number;
}

/** The trex defaults of an init segment, by track ID. ISO/IEC 14496-12 §8.8.3. */
export function trexDefaults(init: Uint8Array): Map<number, SampleDefaults> {
  const out = new Map<number, SampleDefaults>();
  const mvex = findBox(init, 'moov/mvex');
  for (const trex of mvex === null ? [] : findBoxes(mvex.payload, 'trex')) {
    const body = fullBox(trex.payload)?.body;
    if (body === undefined || body.byteLength < 20) continue;
    const v = viewOf(body);
    out.set(v.getUint32(0), {
      duration: v.getUint32(8),
      size: v.getUint32(12),
      flags: v.getUint32(16),
    });
  }
  return out;
}

/** One sample of a track fragment, located in the segment bytes. */
export interface FragmentSample {
  /** Byte offset of the sample data in the segment. */
  readonly offset: number;
  readonly size: number;
  /** Duration in the track timescale. */
  readonly duration: number;
  /** Composition-time offset in the track timescale. */
  readonly cts: number;
  /** Decode time in the track timescale. */
  readonly decodeTime: number;
  /** A sync sample (sample_is_non_sync_sample clear): it decodes on its own. */
  readonly isKeyframe: boolean;
}

/** One track fragment (traf) of a media segment. */
export interface TrackFragmentSamples {
  readonly trackId: number;
  /** The tfdt decode time, or null when the traf has none. */
  readonly baseMediaDecodeTime: number | null;
  readonly samples: readonly FragmentSample[];
}

/**
 * Every track fragment of a media segment with its samples located. Offsets
 * follow the tfhd base rules: the moof with default-base-is-moof, an
 * explicit base offset, else the end of the previous traf's data. Decode
 * times continue across trafs of one track without a tfdt. A sample may
 * point past the end of `data`; callers check `offset + size`.
 */
export function fragmentSamples(
  data: Uint8Array,
  defaults: ReadonlyMap<number, SampleDefaults> = new Map(),
): TrackFragmentSamples[] {
  const out: TrackFragmentSamples[] = [];
  const nextDecode = new Map<number, number>();
  for (const moof of findBoxes(data, 'moof')) {
    let previousEnd = moof.start;
    for (const traf of findBoxes(moof.payload, 'traf')) {
      const tfhdBox = findBox(traf.payload, 'tfhd');
      const tfhd = tfhdBox === null ? null : fullBox(tfhdBox.payload);
      if (tfhd === null || tfhd.body.byteLength < 4) continue;
      const tfhdView = viewOf(tfhd.body);
      const trackId = tfhdView.getUint32(0);
      const fallback = defaults.get(trackId);
      let at = 4;
      let base = tfhd.flags & TFHD_DEFAULT_BASE_IS_MOOF ? moof.start : previousEnd;
      if (tfhd.flags & TFHD_BASE_DATA_OFFSET) {
        base = Number(tfhdView.getBigUint64(at));
        at += 8;
      }
      if (tfhd.flags & TFHD_SAMPLE_DESCRIPTION) at += 4;
      let defaultDuration = fallback?.duration ?? 0;
      let defaultSize = fallback?.size ?? 0;
      let defaultFlags = fallback?.flags ?? 0;
      if (tfhd.flags & TFHD_DEFAULT_DURATION) {
        defaultDuration = tfhdView.getUint32(at);
        at += 4;
      }
      if (tfhd.flags & TFHD_DEFAULT_SIZE) {
        defaultSize = tfhdView.getUint32(at);
        at += 4;
      }
      if (tfhd.flags & TFHD_DEFAULT_FLAGS) defaultFlags = tfhdView.getUint32(at);

      const tfdt = findBox(traf.payload, 'tfdt');
      const tfdtTime =
        tfdt === null ? null : (parseTfdt(tfdt.payload)?.baseMediaDecodeTime ?? null);
      let decode = tfdtTime ?? nextDecode.get(trackId) ?? 0;
      const samples: FragmentSample[] = [];
      let cursor = base;
      for (const trunBox of findBoxes(traf.payload, 'trun')) {
        const trun = fullBox(trunBox.payload);
        if (trun === null || trun.body.byteLength < 4) continue;
        const trunView = viewOf(trun.body);
        const count = trunView.getUint32(0);
        let p = 4;
        if (trun.flags & TRUN_DATA_OFFSET) {
          cursor = base + trunView.getInt32(p);
          p += 4;
        }
        let firstFlags: number | null = null;
        if (trun.flags & TRUN_FIRST_SAMPLE_FLAGS) {
          firstFlags = trunView.getUint32(p);
          p += 4;
        }
        // Each sample's table entry is 4 bytes per field present; a count past
        // the table is malformed, and reading stops at the last whole entry.
        const entry =
          4 * [TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_CTS].filter((f) => trun.flags & f).length;
        for (let i = 0; i < count && p + entry <= trun.body.byteLength; i += 1) {
          let duration = defaultDuration;
          let size = defaultSize;
          let flags = i === 0 && firstFlags !== null ? firstFlags : defaultFlags;
          let cts = 0;
          if (trun.flags & TRUN_DURATION) {
            duration = trunView.getUint32(p);
            p += 4;
          }
          if (trun.flags & TRUN_SIZE) {
            size = trunView.getUint32(p);
            p += 4;
          }
          if (trun.flags & TRUN_FLAGS) {
            flags = trunView.getUint32(p);
            p += 4;
          }
          if (trun.flags & TRUN_CTS) {
            cts = trun.version === 1 ? trunView.getInt32(p) : trunView.getUint32(p);
            p += 4;
          }
          samples.push({
            offset: cursor,
            size,
            duration,
            cts,
            decodeTime: decode,
            // sample_is_non_sync_sample, bit 16 of the sample flags. §8.8.3.1.
            isKeyframe: (flags & 0x10000) === 0,
          });
          cursor += size;
          decode += duration;
        }
      }
      previousEnd = cursor;
      nextDecode.set(trackId, decode);
      out.push({ trackId, baseMediaDecodeTime: tfdtTime, samples });
    }
  }
  return out;
}
