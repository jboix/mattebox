// Writes a copy of the TS rendition with an ID3 timed-metadata stream, and a
// media playlist over it with date ranges, for the E2E timed-metadata test.
// ffmpeg cannot write a timed ID3 stream from scratch, so this adds one: a
// PMT entry of stream type 0x15 and, in each segment, one PES with one ID3
// tag one second after the segment's first video PTS. Segment n carries a
// TXXX frame with the value "segment n".
//
// Usage: node inject-id3.mjs <dir>
//   reads  <dir>/media.m3u8 and seg-NNN.ts
//   writes <dir>/master-metadata.m3u8, metadata.m3u8, and seg-id3-NNN.ts
// Or:    node inject-id3.mjs <in.ts> <out.ts> <value>
//   writes one segment, for the golden fixture muxed-id3.m2ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKET = 188;
const ID3_PID = 0x1ff0;
// metadata_descriptor: application format and metadata format 'ID3 '
// (0xFFFF then the four bytes, twice), service id 0, and flags 0x0F, ISO/IEC
// 13818-1 §2.6.60.
const METADATA_DESCRIPTOR = [
  0x26, 0x0d, 0xff, 0xff, 0x49, 0x44, 0x33, 0x20, 0xff, 0x49, 0x44, 0x33, 0x20, 0x00, 0x0f,
];

const [dir, out, value] = process.argv.slice(2);
if (dir === undefined) {
  console.error('usage: node inject-id3.mjs <dir> | <in.ts> <out.ts> <value>');
  process.exit(1);
}

/** CRC-32/MPEG-2 over a PSI section, ISO/IEC 13818-1 Annex A. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

const pidOf = (packet) => ((packet[1] & 0x1f) << 8) | packet[2];
const payloadOffset = (packet) => ((packet[3] & 0x20) !== 0 ? 5 + packet[4] : 4);

function synchsafe(size) {
  return [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
}

/** An ID3v2.4 tag with one TXXX frame, UTF-8, empty description. */
function id3Tag(value) {
  const body = [0x03, 0x00, ...new TextEncoder().encode(value)];
  const frame = [...new TextEncoder().encode('TXXX'), ...synchsafe(body.length), 0, 0, ...body];
  return Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, ...synchsafe(frame.length), ...frame]);
}

function ptsBytes(pts) {
  return [
    0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1),
    (pts >> 22) & 0xff,
    (((pts >> 15) & 0x7f) << 1) | 1,
    (pts >> 7) & 0xff,
    ((pts & 0x7f) << 1) | 1,
  ];
}

function readPts(bytes, offset) {
  return (
    ((bytes[offset] >> 1) & 0x07) * 2 ** 30 +
    ((bytes[offset + 1] << 7) | (bytes[offset + 2] >> 1)) * 2 ** 15 +
    ((bytes[offset + 3] << 7) | (bytes[offset + 4] >> 1))
  );
}

/** The PES as TS packets on ID3_PID, the last one padded with adaptation stuffing. */
function pesPackets(pes) {
  const packets = [];
  let cc = 0;
  for (let offset = 0; offset < pes.length; offset += 0) {
    const chunk = pes.subarray(offset, offset + PACKET - 4);
    const packet = new Uint8Array(PACKET).fill(0xff);
    packet[0] = 0x47;
    packet[1] = (offset === 0 ? 0x40 : 0) | (ID3_PID >> 8);
    packet[2] = ID3_PID & 0xff;
    if (chunk.length === PACKET - 4) {
      packet[3] = 0x10 | cc;
      packet.set(chunk, 4);
    } else {
      // Adaptation field: its length byte, a flags byte, then stuffing.
      const stuffing = PACKET - 4 - chunk.length;
      packet[3] = 0x30 | cc;
      packet[4] = stuffing - 1;
      if (stuffing > 1) packet[5] = 0x00;
      packet.set(chunk, 4 + stuffing);
    }
    packets.push(packet);
    offset += chunk.length;
    cc = (cc + 1) & 0x0f;
  }
  return packets;
}

/** The segment with the ID3 stream declared in every PMT and one tag after the first PMT. */
function withId3(segment, value) {
  let pmtPid = -1;
  let firstPts = null;
  const packets = [];
  for (let offset = 0; offset + PACKET <= segment.length; offset += PACKET) {
    packets.push(Uint8Array.from(segment.subarray(offset, offset + PACKET)));
  }
  for (const packet of packets) {
    const start = payloadOffset(packet);
    if (pidOf(packet) === 0)
      pmtPid = ((packet[start + 1 + 10] & 0x1f) << 8) | packet[start + 1 + 11];
  }
  let videoPid = -1;
  for (const packet of packets) {
    if (pidOf(packet) !== pmtPid || (packet[1] & 0x40) === 0) continue;
    const section = start(packet);
    const length = ((packet[section + 1] & 0x0f) << 8) | packet[section + 2];
    const crcAt = section + 3 + length - 4;
    const programInfo = ((packet[section + 10] & 0x0f) << 8) | packet[section + 11];
    for (let cursor = section + 12 + programInfo; cursor + 5 <= crcAt; ) {
      if (packet[cursor] === 0x1b)
        videoPid = ((packet[cursor + 1] & 0x1f) << 8) | packet[cursor + 2];
      cursor += 5 + (((packet[cursor + 3] & 0x0f) << 8) | packet[cursor + 4]);
    }
    if (packet.subarray(section, crcAt).includes(0x15)) continue;
    // A stream entry: type 0x15, the PID, and the metadata_descriptor
    // (tag 0x26) naming the ID3 format, as Apple's timed metadata spec
    // requires. Then a new CRC.
    const entry = [0x15, 0xe0 | (ID3_PID >> 8), ID3_PID & 0xff, 0xf0, METADATA_DESCRIPTOR.length];
    packet.set([...entry, ...METADATA_DESCRIPTOR], crcAt);
    const added = entry.length + METADATA_DESCRIPTOR.length;
    const newLength = length + added;
    packet[section + 1] = (packet[section + 1] & 0xf0) | (newLength >> 8);
    packet[section + 2] = newLength & 0xff;
    const crc = crc32(packet.subarray(section, crcAt + added));
    packet.set([crc >>> 24, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff], crcAt + added);
  }
  for (const packet of packets) {
    if (pidOf(packet) !== videoPid || (packet[1] & 0x40) === 0) continue;
    const pes = payloadOffset(packet);
    if ((packet[pes + 7] & 0x80) !== 0) firstPts = readPts(packet, pes + 9);
    break;
  }
  if (firstPts === null) throw new Error('no video PTS in the segment');
  const tag = id3Tag(value);
  const header = [0, 0, 1, 0xbd, 0, 0, 0x84, 0x80, 0x05, ...ptsBytes(firstPts + 90000)];
  const pes = Uint8Array.from([...header, ...tag]);
  const pesLength = pes.length - 6;
  pes[4] = pesLength >> 8;
  pes[5] = pesLength & 0xff;
  const at = packets.findIndex((packet) => pidOf(packet) === pmtPid) + 1;
  packets.splice(at, 0, ...pesPackets(pes));
  const out = new Uint8Array(packets.length * PACKET);
  packets.forEach((packet, i) => {
    out.set(packet, i * PACKET);
  });
  return out;
}

/** The PSI section's first byte: past the header, adaptation field, and pointer_field. */
function start(packet) {
  const offset = payloadOffset(packet);
  return offset + 1 + packet[offset];
}

if (out !== undefined) {
  writeFileSync(out, withId3(readFileSync(dir), value ?? ''));
  process.exit(0);
}

const media = readFileSync(join(dir, 'media.m3u8'), 'utf8');
let n = 0;
for (const line of media.split('\n')) {
  const match = /^seg-(\d+)\.ts$/.exec(line);
  if (match === null) continue;
  const segment = readFileSync(join(dir, line));
  writeFileSync(join(dir, `seg-id3-${match[1]}.ts`), withId3(segment, `segment ${n}`));
  n += 1;
}

// Two date ranges on the program clock that starts at the first segment: a
// span from 2 s to 6 s and an instant at 9 s.
const dated = media
  .replace(
    '#EXT-X-PLAYLIST-TYPE:VOD',
    [
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
      '#EXT-X-DATERANGE:ID="span",CLASS="com.example.span",START-DATE="2026-01-01T00:00:02.000Z",DURATION=4.0,X-NOTE="two to six"',
      '#EXT-X-DATERANGE:ID="instant",CLASS="com.example.instant",START-DATE="2026-01-01T00:00:09.000Z",DURATION=0',
    ].join('\n'),
  )
  .replace(/^seg-(\d+)\.ts$/gm, 'seg-id3-$1.ts');
writeFileSync(join(dir, 'metadata.m3u8'), dated);
const master = readFileSync(join(dir, 'master.m3u8'), 'utf8');
writeFileSync(join(dir, 'master-metadata.m3u8'), master.replace('media.m3u8', 'metadata.m3u8'));
