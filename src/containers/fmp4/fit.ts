/**
 * Fits a trick-play fragment to its slot in the playlist, so the frames an
 * I-frame stream carries cover the whole segment in the buffer. Pure bytes in,
 * bytes out.
 *
 * HLS I-frame playlists (RFC 8216 §4.3.3.6) address a byte range around one
 * key frame. In fMP4 the range holds the fragment's moof and only its first
 * sample: the moof still describes every sample and the mdat header claims
 * the full size, which an MSE parser reads as a fragment still arriving. In
 * a transport stream the range also cuts into the frames on either side,
 * and the transmuxer turns those stubs into samples a decoder cannot decode.
 * Either way one key frame lasts one frame period, so the buffer holds
 * islands a fast playback rate stalls in.
 *
 * An I-frame track is all key frames, so a fitted fragment keeps only the
 * key frames whose bytes are present. Each lasts until the next one, and
 * the last until the end of the segment.
 *
 * An encrypted fragment keeps each kept frame's IV and subsample map: the
 * `senc` entries, cut by the sizes `saiz` gives (ISO/IEC 23001-7 §7.2), go
 * into the new fragment. Without them the browser cannot decrypt the
 * frames and fails the append. Encryption described in a form not read
 * here leaves the fragment as it came.
 */
import type { SampleDefaults } from '../mp4-box/index.js';
import { findBox, fragmentSamples, fullBox, viewOf } from '../mp4-box/index.js';
import type { Sample, SampleEncryption } from './writer.js';
import { writeMediaSegment } from './writer.js';

/**
 * The first traf's per-sample encryption entries, null for a clear
 * fragment, or undefined when it is encrypted in a form not read here: a
 * PIFF `uuid` box, or a `senc` without the `saiz` that sizes its entries.
 */
function encryptionOf(
  data: Uint8Array,
): { flags: number; entries: Uint8Array[] } | null | undefined {
  const senc = findBox(data, 'moof/traf/senc');
  const saiz = findBox(data, 'moof/traf/saiz');
  if (senc === null) {
    return saiz === null && findBox(data, 'moof/traf/uuid') === null ? null : undefined;
  }
  const sencBox = fullBox(senc.payload);
  const saizBox = saiz === null ? null : fullBox(saiz.payload);
  if (sencBox === null || saizBox === null || sencBox.body.byteLength < 4) return undefined;
  // saiz: with flag 0x1, aux_info_type and its parameter first.
  let at = saizBox.flags & 1 ? 8 : 0;
  const sizes = saizBox.body;
  if (sizes.byteLength < at + 5) return undefined;
  const fixed = sizes[at] as number;
  const count = viewOf(sizes).getUint32(at + 1);
  at += 5;
  const sizeOf = (i: number): number => (fixed !== 0 ? fixed : (sizes[at + i] ?? 0));
  const body = sencBox.body;
  if (viewOf(body).getUint32(0) !== count) return undefined;
  const entries: Uint8Array[] = [];
  let cursor = 4;
  for (let i = 0; i < count; i += 1) {
    const size = sizeOf(i);
    if (cursor + size > body.byteLength) return undefined;
    entries.push(body.subarray(cursor, cursor + size));
    cursor += size;
  }
  return { flags: sencBox.flags, entries };
}

/** A fragment already filling this share of its slot is left as it is. */
const FILLED = 0.9;

/**
 * The fragment rebuilt to last `duration` seconds, or null when it already
 * does and its bytes are whole (a DASH trick-mode segment). Throws when no
 * whole key frame is present: nothing could be shown for the slot.
 */
export function fitFragment(
  data: Uint8Array,
  timescale: number,
  duration: number,
  defaults: ReadonlyMap<number, SampleDefaults> = new Map(),
): Uint8Array | null {
  // A trick stream carries video only; a second traf, if any, is dropped.
  const traf = fragmentSamples(data, defaults)[0];
  if (traf === undefined) return null;
  const encryption = encryptionOf(data);
  if (encryption === undefined) return null;
  const present = [];
  for (const sample of traf.samples) {
    if (sample.offset + sample.size > data.byteLength) break;
    present.push(sample);
  }
  const keys = present.filter((s) => s.isKeyframe);
  const first = keys[0];
  if (first === undefined) throw new RangeError('trick fragment holds no whole key frame');
  const target = Math.round(duration * timescale);
  const total = present.reduce((sum, s) => sum + s.duration, 0);
  // Whole, all key frames, filling the slot: a DASH trick-mode segment.
  if (keys.length === traf.samples.length && total >= target * FILLED) return null;
  // The slot starts with the segment's first sample, even a stub before the key frame.
  const end = (traf.samples[0]?.decodeTime ?? first.decodeTime) + target;
  const samples: Sample[] = keys.map((s, i) => ({
    data: data.subarray(s.offset, s.offset + s.size),
    duration: Math.max(1, (keys[i + 1]?.decodeTime ?? end) - s.decodeTime),
    cts: s.cts,
    isKeyframe: true,
  }));
  const mfhd = findBox(data, 'moof/mfhd');
  const body = mfhd === null ? null : fullBox(mfhd.payload)?.body;
  const sequence =
    body !== undefined && body !== null && body.byteLength >= 4 ? viewOf(body).getUint32(0) : 1;
  let kept: SampleEncryption | undefined;
  if (encryption !== null) {
    const entries = keys.map((s) => encryption.entries[traf.samples.indexOf(s)]);
    if (entries.some((entry) => entry === undefined)) return null;
    kept = { flags: encryption.flags, entries: entries as Uint8Array[] };
  }
  return writeMediaSegment(sequence, [
    {
      trackId: traf.trackId,
      baseMediaDecodeTime: first.decodeTime,
      samples,
      ...(kept === undefined ? {} : { encryption: kept }),
    },
  ]);
}
