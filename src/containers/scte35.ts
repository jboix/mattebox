/**
 * A summary of an SCTE-35 splice_info_section (SCTE 35 §9.6): the command
 * type, splice_insert's event, out-of-network flag and break duration, and
 * each segmentation_descriptor's event, type, and duration. Not a full
 * decoder; the record keeps the section for a page that needs more. Every
 * read is bounded, so a malformed section yields null or a partial summary,
 * never a throw.
 */
import type { Scte35Segmentation, Scte35Summary } from '../types/metadata.js';

const TABLE_ID = 0xfc;
const SPLICE_INSERT = 0x05;
const SEGMENTATION_DESCRIPTOR = 0x02;
const CLOCK = 90_000;

/** A 33-bit 90 kHz value whose top bit is the low bit of `at`'s byte, in seconds. */
function seconds33(bytes: Uint8Array, at: number): number {
  const high = (bytes[at] ?? 0) & 0x01;
  const low =
    ((bytes[at + 1] ?? 0) * 2 ** 24 +
      (((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 8) | (bytes[at + 4] ?? 0))) >>>
    0;
  return (high * 2 ** 32 + low) / CLOCK;
}

function uint32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

/** The length of a splice_time() at `at`: five bytes with a time, one without (§9.4.1). */
function spliceTimeLength(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) & 0x80) !== 0 ? 5 : 1;
}

/** splice_insert() (§9.7.3), from its first byte. */
function spliceInsert(bytes: Uint8Array, at: number): Partial<Scte35Summary> {
  const eventId = uint32(bytes, at);
  const cancel = ((bytes[at + 4] ?? 0) & 0x80) !== 0;
  if (cancel) return { eventId, cancel };
  const flags = bytes[at + 5] ?? 0;
  const outOfNetwork = (flags & 0x80) !== 0;
  const programSplice = (flags & 0x40) !== 0;
  const hasDuration = (flags & 0x20) !== 0;
  const immediate = (flags & 0x10) !== 0;
  let cursor = at + 6;
  if (programSplice && !immediate) cursor += spliceTimeLength(bytes, cursor);
  if (!programSplice) {
    const count = bytes[cursor] ?? 0;
    cursor += 1;
    for (let i = 0; i < count; i += 1) {
      cursor += 1;
      if (!immediate) cursor += spliceTimeLength(bytes, cursor);
    }
  }
  return {
    eventId,
    cancel,
    outOfNetwork,
    ...(hasDuration ? { breakDuration: seconds33(bytes, cursor) } : {}),
  };
}

/** segmentation_descriptor() (§10.3.3), from the byte after its identifier. */
function segmentation(bytes: Uint8Array, at: number, end: number): Scte35Segmentation | null {
  if (at + 5 > end) return null;
  const eventId = uint32(bytes, at);
  const cancel = ((bytes[at + 4] ?? 0) & 0x80) !== 0;
  if (cancel) return { eventId, cancel };
  const flags = bytes[at + 5] ?? 0;
  const programSegmentation = (flags & 0x80) !== 0;
  const hasDuration = (flags & 0x40) !== 0;
  let cursor = at + 6;
  // Per component: component_tag, then reserved bits and a 33-bit pts_offset.
  if (!programSegmentation) cursor += 1 + (bytes[cursor] ?? 0) * 6;
  let duration: number | undefined;
  if (hasDuration) {
    duration = (uint32(bytes, cursor) * 256 + (bytes[cursor + 4] ?? 0)) / CLOCK;
    cursor += 5;
  }
  // segmentation_upid_type, segmentation_upid_length, the upid.
  cursor += 2 + (bytes[cursor + 1] ?? 0);
  if (cursor >= end) return { eventId, cancel, ...(duration !== undefined ? { duration } : {}) };
  return {
    eventId,
    cancel,
    typeId: bytes[cursor] as number,
    ...(duration !== undefined ? { duration } : {}),
  };
}

/** The summary of a splice_info_section, or null when the bytes are not one. */
export function scte35Summary(bytes: Uint8Array): Scte35Summary | null {
  if (bytes.byteLength < 16 || bytes[0] !== TABLE_ID) return null;
  // An encrypted section's command and descriptors are unreadable.
  if (((bytes[4] ?? 0) & 0x80) !== 0) return null;
  const commandLength = (((bytes[11] ?? 0) & 0x0f) << 8) | (bytes[12] ?? 0);
  const commandType = bytes[13] as number;
  const command = commandType === SPLICE_INSERT ? spliceInsert(bytes, 14) : {};
  // A legacy 0xFFF command length means "unknown"; the descriptors cannot be found then.
  const segmentations: Scte35Segmentation[] = [];
  if (commandLength !== 0xfff) {
    let cursor = 14 + commandLength;
    const loopLength = ((bytes[cursor] ?? 0) << 8) | (bytes[cursor + 1] ?? 0);
    cursor += 2;
    const loopEnd = Math.min(cursor + loopLength, bytes.byteLength);
    while (cursor + 2 <= loopEnd) {
      const tag = bytes[cursor] as number;
      const end = Math.min(cursor + 2 + (bytes[cursor + 1] as number), loopEnd);
      // After the tag and length, a four-byte identifier ('CUEI').
      if (tag === SEGMENTATION_DESCRIPTOR) {
        const found = segmentation(bytes, cursor + 6, end);
        if (found !== null) segmentations.push(found);
      }
      cursor = end;
    }
  }
  return { commandType, ...command, segmentations };
}
