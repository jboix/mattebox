// Writes a CEA-608 captioned copy of an H.264 fMP4 rendition for the E2E
// corpus: ffmpeg cannot emit 608 captions, so this puts an ATSC A/53 caption
// SEI NAL in front of every video sample. Each segment n shows "CC1 n" to
// "CC4 n", one pop-on caption per channel: CC1 and CC2 on field 1, CC3 and
// CC4 on field 2.
//
// Only sizes change: each sample's trun size, the mdat size, and the sidx
// referenced size. The moof keeps its size, so the trun data offset holds.
//
// Usage: node inject-captions.mjs <dir> <rendition>
//   reads  <dir>/<rendition>.m3u8, init-<rendition>.mp4, seg-<rendition>-NNN.m4s
//   writes <dir>/cc-<rendition>.m3u8 and seg-cc-<rendition>-NNN.m4s
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, rendition] = process.argv.slice(2);
if (dir === undefined || rendition === undefined) {
  console.error('usage: node inject-captions.mjs <dir> <rendition>');
  process.exit(1);
}

/** The top-level and nested boxes, as [type, offset, size]. */
function boxes(bytes, start = 0, end = bytes.length, out = []) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    out.push([type, offset, size]);
    if (type === 'moof' || type === 'traf') boxes(bytes, offset + 8, offset + size, out);
    offset += size;
  }
  return out;
}

/** Odd parity in bit 7, as CEA-608 transmits every byte. */
function parity(byte) {
  let ones = 0;
  for (let bit = 0; bit < 7; bit += 1) ones += (byte >> bit) & 1;
  return ones % 2 === 0 ? byte | 0x80 : byte & 0x7f;
}

/** The byte pairs of a pop-on caption on one channel, from its first frame. */
function popOn(control, pac, text) {
  const pairs = [
    [control, 0x20], // RCL: resume caption loading
    [pac, 0x40], // PAC: row 15, no indent
  ];
  const chars = text.padEnd(text.length + (text.length % 2), '\0');
  for (let i = 0; i < chars.length; i += 2)
    pairs.push([chars.charCodeAt(i), chars.charCodeAt(i + 1)]);
  pairs.push([control, 0x2f]); // EOC: shows it
  return pairs;
}

/**
 * The pair each frame carries per field, keyed by frame index. Field 1 holds
 * CC1 (control 0x14) and CC2 (0x1c); field 2 holds CC3 (0x15, PAC 0x14) and
 * CC4 (0x1d, PAC 0x1c).
 */
function schedule(n, frames) {
  const field1 = new Map();
  const field2 = new Map();
  const place = (map, from, pairs) => {
    for (const [i, pair] of pairs.entries()) map.set(from + i, pair);
  };
  place(field1, 0, popOn(0x14, 0x14, `CC1 ${n}`));
  place(field1, 12, popOn(0x1c, 0x1c, `CC2 ${n}`));
  place(field2, 0, popOn(0x15, 0x14, `CC3 ${n}`));
  place(field2, 12, popOn(0x1d, 0x1c, `CC4 ${n}`));
  const end = Math.min(frames - 2, 100);
  field1.set(end, [0x14, 0x2c]); // EDM: ends CC1
  field1.set(end + 1, [0x1c, 0x2c]); // EDM: ends CC2
  field2.set(end, [0x15, 0x2c]);
  field2.set(end + 1, [0x1d, 0x2c]);
  return [field1, field2];
}

/** One H.264 SEI NAL, length-prefixed, with ATSC caption data for this frame. */
function captionNal(pair1, pair2) {
  const cc = (valid, type, pair) => [0xf8 | (valid ? 0x04 : 0) | type, ...(pair ?? [0x80, 0x80])];
  const payload = [
    0xb5,
    0x00,
    0x31,
    0x47,
    0x41,
    0x39,
    0x34, // T.35 United States, ATSC, "GA94"
    0x03, // user_data_type_code: cc_data
    0x40 | 2, // process_cc_data_flag, cc_count 2
    0xff, // em_data
    ...cc(pair1 !== undefined, 0, pair1?.map(parity)),
    ...cc(pair2 !== undefined, 1, pair2?.map(parity)),
    0xff, // marker_bits
  ];
  const rbsp = [0x06, 0x04, payload.length, ...payload, 0x80];
  // Emulation prevention (ITU-T H.264 §7.4.1): no 00 00 0x with x <= 3.
  const nal = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      nal.push(0x03);
      zeros = 0;
    }
    nal.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from([
    (nal.length >>> 24) & 0xff,
    (nal.length >>> 16) & 0xff,
    (nal.length >>> 8) & 0xff,
    nal.length & 0xff,
    ...nal,
  ]);
}

function inject(segment, n) {
  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  const found = boxes(segment);
  const at = (type) => found.find(([t]) => t === type);
  const [, trunAt] = at('trun');
  const [, mdatAt, mdatSize] = at('mdat');
  const flags = view.getUint32(trunAt + 8) & 0xffffff;
  if ((flags & 0x200) === 0) throw new Error('the trun carries no per-sample size');
  if ((flags & 0x100) !== 0 || (flags & 0x400) !== 0 || (flags & 0x800) !== 0) {
    throw new Error('the injector reads trun entries of sample size only');
  }
  const count = view.getUint32(trunAt + 12);
  let cursor = trunAt + 16 + ((flags & 0x1) !== 0 ? 4 : 0) + ((flags & 0x4) !== 0 ? 4 : 0);
  const [field1, field2] = schedule(n, count);
  const chunks = [];
  let source = mdatAt + 8;
  let added = 0;
  const out = Uint8Array.from(segment);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < count; i += 1) {
    const size = view.getUint32(cursor);
    const nal = captionNal(field1.get(i), field2.get(i));
    chunks.push(nal, segment.subarray(source, source + size));
    outView.setUint32(cursor, size + nal.length);
    source += size;
    added += nal.length;
    cursor += 4;
  }
  outView.setUint32(mdatAt, mdatSize + added);
  const sidx = at('sidx');
  if (sidx !== undefined) {
    // sidx v0: 12 header + 4 reference_ID + 4 timescale + 4+4 times + 2+2 counts, then the reference.
    const version = segment[sidx[1] + 8];
    const reference = sidx[1] + 12 + 8 + (version === 0 ? 8 : 16) + 4;
    const word = view.getUint32(reference);
    outView.setUint32(reference, (word & 0x80000000) | ((word & 0x7fffffff) + added));
  }
  const head = out.subarray(0, mdatAt + 8);
  const tail = segment.subarray(source);
  return Buffer.concat([head, ...chunks, tail]);
}

const playlist = readFileSync(join(dir, `${rendition}.m3u8`), 'utf8');
const lines = playlist.split('\n').map((line) => {
  const match = /^seg-(.+)-(\d+)\.m4s$/.exec(line.trim());
  if (match === null) return line;
  const n = Number(match[2]);
  const copy = `seg-cc-${match[1]}-${match[2]}.m4s`;
  writeFileSync(join(dir, copy), inject(readFileSync(join(dir, line.trim())), n));
  return copy;
});
writeFileSync(join(dir, `cc-${rendition}.m3u8`), lines.join('\n'));
