/**
 * MPEG-TS demux: 188-byte packets into PES payloads, grouped by elementary
 * stream. PAT names the PMT, the PMT names the elementary PIDs and their
 * stream types, and the payload-unit-start flag frames each PES. Nothing
 * here allocates per packet beyond the growing payload buffers, and every
 * loop strictly advances, so a truncated or garbage segment returns what it
 * could parse rather than throwing or spinning.
 */

const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;

/** MPEG-TS stream_type values this transmuxer routes. */
export const STREAM_TYPE = {
  h264: 0x1b,
  aacAdts: 0x0f,
  mp3a: 0x03,
  mp3b: 0x04,
  ac3: 0x81,
  metadata: 0x15,
  privateData: 0x06,
} as const;

export type ElementaryKind = 'video' | 'audio' | 'id3';

/** One reassembled PES packet: its payload and the timestamps from the header. */
export interface PesPacket {
  readonly pid: number;
  readonly streamType: number;
  readonly kind: ElementaryKind;
  /** 90 kHz presentation timestamp, or null when the header omitted it. */
  readonly pts: number | null;
  /** 90 kHz decode timestamp; defaults to pts when the header omits it. */
  readonly dts: number | null;
  readonly data: Uint8Array;
}

export interface DemuxResult {
  readonly video: readonly PesPacket[];
  readonly audio: readonly PesPacket[];
  readonly id3: readonly PesPacket[];
  /** Set when the input carried no sync bytes at all: not a TS stream. */
  readonly notTransportStream: boolean;
}

interface PesAccumulator {
  readonly pid: number;
  readonly streamType: number;
  readonly kind: ElementaryKind;
  chunks: Uint8Array[];
  length: number;
}

function kindOf(streamType: number): ElementaryKind | null {
  if (streamType === STREAM_TYPE.h264) return 'video';
  if (
    streamType === STREAM_TYPE.aacAdts ||
    streamType === STREAM_TYPE.mp3a ||
    streamType === STREAM_TYPE.mp3b ||
    streamType === STREAM_TYPE.ac3
  ) {
    return 'audio';
  }
  if (streamType === STREAM_TYPE.metadata) return 'id3';
  return null;
}

/** True when the buffer carries the TS sync byte at the packet cadence. */
export function looksLikeTransportStream(data: Uint8Array): boolean {
  if (data.byteLength < PACKET_SIZE) return false;
  // Two consecutive sync bytes one packet apart is the accepted sniff.
  let offset = 0;
  while (offset + PACKET_SIZE < data.byteLength) {
    if (data[offset] === SYNC_BYTE && data[offset + PACKET_SIZE] === SYNC_BYTE) return true;
    offset += 1;
    // A real stream syncs within the first packet; bound the search.
    if (offset > PACKET_SIZE) return false;
  }
  return false;
}

/** Reads a 33-bit PTS/DTS field from a 5-byte PES timestamp region. */
function readTimestamp(data: Uint8Array, offset: number): number {
  const b0 = data[offset] ?? 0;
  const b1 = data[offset + 1] ?? 0;
  const b2 = data[offset + 2] ?? 0;
  const b3 = data[offset + 3] ?? 0;
  const b4 = data[offset + 4] ?? 0;
  // Three bits (32..30), marker, fifteen (29..15), marker, fifteen (14..0),
  // marker. The whole value can exceed 2^31, so the group weights are applied
  // with multiplication: high is bits 30 and up, mid is bits 15 and up.
  const high = (b0 >> 1) & 0x07;
  const mid = ((b1 << 7) | (b2 >> 1)) & 0x7fff;
  const low = ((b3 << 7) | (b4 >> 1)) & 0x7fff;
  return high * 0x4000_0000 + mid * 0x8000 + low;
}

/** Parses one completed PES accumulator into a packet with timestamps. */
function finishPes(acc: PesAccumulator): PesPacket | null {
  const buf = concatChunks(acc.chunks, acc.length);
  // PES start code 0x000001 then stream_id.
  if (buf.byteLength < 9 || buf[0] !== 0x00 || buf[1] !== 0x00 || buf[2] !== 0x01) return null;
  const headerDataLength = buf[8] ?? 0;
  const ptsDtsFlags = (buf[7] ?? 0) >> 6;
  let pts: number | null = null;
  let dts: number | null = null;
  if (ptsDtsFlags & 0x2 && buf.byteLength >= 14) {
    pts = readTimestamp(buf, 9);
    dts = pts;
    if (ptsDtsFlags & 0x1 && buf.byteLength >= 19) dts = readTimestamp(buf, 14);
  }
  const payloadStart = 9 + headerDataLength;
  const data = payloadStart <= buf.byteLength ? buf.subarray(payloadStart) : new Uint8Array(0);
  return { pid: acc.pid, streamType: acc.streamType, kind: acc.kind, pts, dts, data };
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function demux(data: Uint8Array): DemuxResult {
  if (!looksLikeTransportStream(data)) {
    return { video: [], audio: [], id3: [], notTransportStream: true };
  }

  // Align to the first sync byte; field recordings often carry a few bytes
  // of leading garbage before the first packet.
  let base = 0;
  while (base < data.byteLength && data[base] !== SYNC_BYTE) base += 1;

  let pmtPid = -1;
  const streamTypes = new Map<number, number>();
  const accumulators = new Map<number, PesAccumulator>();
  const completed: PesPacket[] = [];

  function flush(pid: number): void {
    const acc = accumulators.get(pid);
    if (acc === undefined || acc.length === 0) return;
    const packet = finishPes(acc);
    if (packet !== null) completed.push(packet);
    accumulators.delete(pid);
  }

  for (let offset = base; offset + PACKET_SIZE <= data.byteLength; offset += PACKET_SIZE) {
    if (data[offset] !== SYNC_BYTE) {
      // Lost sync. Resynchronize to the next sync byte within this packet.
      let resync = offset + 1;
      while (resync < data.byteLength && data[resync] !== SYNC_BYTE) resync += 1;
      offset = resync - PACKET_SIZE;
      continue;
    }
    const b1 = data[offset + 1] ?? 0;
    const b2 = data[offset + 2] ?? 0;
    const b3 = data[offset + 3] ?? 0;
    const pusi = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | b2;
    const adaptationControl = (b3 >> 4) & 0x3;
    const hasPayload = (adaptationControl & 0x1) !== 0;
    if (!hasPayload) continue;

    let payloadOffset = offset + 4;
    if (adaptationControl & 0x2) {
      const adaptationLength = data[payloadOffset] ?? 0;
      payloadOffset += 1 + adaptationLength;
    }
    if (payloadOffset >= offset + PACKET_SIZE) continue;
    const payload = data.subarray(payloadOffset, offset + PACKET_SIZE);

    if (pid === 0) {
      // PAT: pointer_field, then the section. The first program's PMT PID
      // sits in the last two bytes of the first program entry.
      const pointer = payload[0] ?? 0;
      const section = payload.subarray(1 + pointer);
      if (section.byteLength >= 13) {
        pmtPid = (((section[10] ?? 0) & 0x1f) << 8) | (section[11] ?? 0);
      }
      continue;
    }

    if (pid === pmtPid && pusi) {
      // PMT: walk the elementary stream loop and record stream types.
      const pointer = payload[0] ?? 0;
      const section = payload.subarray(1 + pointer);
      const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
      const programInfoLength = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
      let cursor = 12 + programInfoLength;
      const end = Math.min(3 + sectionLength - 4, section.byteLength);
      while (cursor + 5 <= end) {
        const streamType = section[cursor] ?? 0;
        const elementaryPid =
          (((section[cursor + 1] ?? 0) & 0x1f) << 8) | (section[cursor + 2] ?? 0);
        const esInfoLength =
          (((section[cursor + 3] ?? 0) & 0x0f) << 8) | (section[cursor + 4] ?? 0);
        streamTypes.set(elementaryPid, streamType);
        cursor += 5 + esInfoLength;
      }
      continue;
    }

    const streamType = streamTypes.get(pid);
    if (streamType === undefined) continue;
    const kind = kindOf(streamType);
    if (kind === null) continue;

    if (pusi) {
      flush(pid);
      accumulators.set(pid, { pid, streamType, kind, chunks: [], length: 0 });
    }
    const acc = accumulators.get(pid);
    if (acc === undefined) continue;
    acc.chunks.push(payload);
    acc.length += payload.byteLength;
  }

  for (const pid of accumulators.keys()) flush(pid);

  return {
    video: completed.filter((p) => p.kind === 'video'),
    audio: completed.filter((p) => p.kind === 'audio'),
    id3: completed.filter((p) => p.kind === 'id3'),
    notTransportStream: false,
  };
}

/**
 * Corrects a 33-bit timestamp series for wrap. When a value drops by more
 * than half the range from the previous one, the counter rolled over; the
 * accumulated offset carries every later value past the wrap. The reference
 * anchors the first value so the output starts near zero regardless of where
 * in the 26.5 hour cycle the segment sits.
 */
export function unrollTimestamps(values: readonly (number | null)[]): number[] {
  const RANGE = 0x2_0000_0000;
  const HALF = 0x1_0000_0000;
  let offset = 0;
  let previous: number | null = null;
  const out: number[] = [];
  for (const value of values) {
    if (value === null) {
      out.push(previous ?? 0);
      continue;
    }
    if (previous !== null && value + offset < previous - HALF) offset += RANGE;
    const unrolled = value + offset;
    out.push(unrolled);
    previous = unrolled;
  }
  return out;
}
