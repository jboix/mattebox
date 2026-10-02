/**
 * The DASH event message box (ISO/IEC 23009-1 §5.10.3.3), read from the top
 * level of a media segment, where it sits before the moof. Version 0 times an
 * event from the segment's earliest presentation time; version 1 places it
 * on the track's media timeline, the same clock as tfdt.
 */
import { fourcc, viewOf } from './mp4-box/index.js';

export interface EmsgBox {
  readonly version: number;
  readonly scheme: string;
  readonly value: string;
  readonly timescale: number;
  /** Version 0: presentation_time_delta. Version 1: presentation_time. In `timescale` units. */
  readonly time: number;
  /** In `timescale` units; null for 0xFFFFFFFF, an unknown duration. */
  readonly duration: number | null;
  readonly id: number;
  readonly data: Uint8Array;
}

/** A null-terminated UTF-8 string at `at`, and the offset after its null. */
function cString(bytes: Uint8Array, at: number): [string, number] | null {
  const end = bytes.indexOf(0, at);
  if (end < 0) return null;
  return [new TextDecoder().decode(bytes.subarray(at, end)), end + 1];
}

function parseEmsg(payload: Uint8Array): EmsgBox | null {
  if (payload.byteLength < 4) return null;
  const view = viewOf(payload);
  const version = payload[0] as number;
  let cursor = 4;
  if (version === 0) {
    const scheme = cString(payload, cursor);
    if (scheme === null) return null;
    const value = cString(payload, scheme[1]);
    if (value === null || value[1] + 16 > payload.byteLength) return null;
    cursor = value[1];
    const duration = view.getUint32(cursor + 8);
    return {
      version,
      scheme: scheme[0],
      value: value[0],
      timescale: view.getUint32(cursor),
      time: view.getUint32(cursor + 4),
      duration: duration === 0xffffffff ? null : duration,
      id: view.getUint32(cursor + 12),
      data: payload.subarray(cursor + 16),
    };
  }
  if (version !== 1 || payload.byteLength < cursor + 20) return null;
  const timescale = view.getUint32(cursor);
  const time = view.getUint32(cursor + 4) * 2 ** 32 + view.getUint32(cursor + 8);
  const duration = view.getUint32(cursor + 12);
  const id = view.getUint32(cursor + 16);
  const scheme = cString(payload, cursor + 20);
  if (scheme === null) return null;
  const value = cString(payload, scheme[1]);
  if (value === null) return null;
  return {
    version,
    scheme: scheme[0],
    value: value[0],
    timescale,
    time,
    duration: duration === 0xffffffff ? null : duration,
    id,
    data: payload.subarray(value[1]),
  };
}

/** The segment's top-level emsg boxes, up to its first moof. */
export function readEmsg(segment: Uint8Array): EmsgBox[] {
  const out: EmsgBox[] = [];
  const view = viewOf(segment);
  let offset = 0;
  while (offset + 8 <= segment.byteLength) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1 && offset + 16 <= segment.byteLength) {
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) {
      size = segment.byteLength - offset;
    }
    const type = fourcc(segment, offset + 4);
    if (size < header || type === 'moof' || type === 'mdat') break;
    if (type === 'emsg') {
      const box = parseEmsg(
        segment.subarray(offset + header, Math.min(offset + size, segment.byteLength)),
      );
      if (box !== null && box.timescale > 0) out.push(box);
    }
    offset += size;
  }
  return out;
}
