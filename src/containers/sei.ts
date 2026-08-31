/**
 * Caption bytes out of H.264 SEI, the container-layer half of entanglement #1.
 * Both routes to CEA-608 captions meet here: ts-transmux already splits NALs
 * and hands its SEI units in, and nal-scan walks an fMP4 mdat for the same
 * ones. This module knows only how to turn a SEI NAL into the CEA-608 byte
 * pairs it carries; the channel decode lives in the text-cea608 stage. Living
 * in the container layer keeps that stage from importing either source.
 *
 * The path decoded is ATSC A/53: a user_data_registered_itu_t_t35 SEI message
 * (payload type 4), country 0xB5, provider "GA94", user_data_type 0x03, which
 * frames the cc_data triples the 608 and 708 caption channels ride in.
 */

/** One caption-data triple: the CEA-608/708 field type and its two bytes. */
export interface CcTriple {
  /** 0 and 1 are the two CEA-608 fields; 2 and 3 are CEA-708 DTVCC packets. */
  readonly type: number;
  readonly a: number;
  readonly b: number;
}

/** Strips emulation-prevention bytes (00 00 03 -> 00 00) so payload sizes read true. */
function toRbsp(nal: Uint8Array, start: number): Uint8Array {
  const out = new Uint8Array(nal.byteLength - start);
  let count = 0;
  let zeros = 0;
  for (let i = start; i < nal.byteLength; i += 1) {
    const byte = nal[i] as number;
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out[count] = byte;
    count += 1;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, count);
}

/**
 * Extracts every CEA-608/708 cc_data triple from one SEI NAL. Returns an empty
 * array for a SEI that carries no ATSC caption user data, and never reads past
 * the buffer: a malformed message stops the walk.
 */
export function ccTriplesFromSei(seiNal: Uint8Array): CcTriple[] {
  // SEI RBSP begins after the one-byte NAL header.
  const rbsp = toRbsp(seiNal, 1);
  const triples: CcTriple[] = [];
  let offset = 0;
  const length = rbsp.byteLength;
  while (offset < length) {
    // payloadType and payloadSize are each a run of 0xFF bytes plus a final byte.
    let payloadType = 0;
    while (offset < length && rbsp[offset] === 0xff) {
      payloadType += 255;
      offset += 1;
    }
    if (offset >= length) break;
    payloadType += rbsp[offset] as number;
    offset += 1;
    let payloadSize = 0;
    while (offset < length && rbsp[offset] === 0xff) {
      payloadSize += 255;
      offset += 1;
    }
    if (offset >= length) break;
    payloadSize += rbsp[offset] as number;
    offset += 1;
    if (offset + payloadSize > length) break;

    if (payloadType === 4) {
      appendAtscCc(rbsp.subarray(offset, offset + payloadSize), triples);
    }
    offset += payloadSize;
  }
  return triples;
}

const GA94 = 0x47413934; // "GA94"

function appendAtscCc(payload: Uint8Array, out: CcTriple[]): void {
  if (payload.byteLength < 10) return;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  // itu_t_t35_country_code, provider_code, user_identifier.
  const country = payload[0];
  const provider = view.getUint16(1);
  const userIdentifier = view.getUint32(3);
  if (country !== 0xb5 || provider !== 0x0031 || userIdentifier !== GA94) return;
  const userDataTypeCode = payload[7];
  if (userDataTypeCode !== 0x03) return;
  // cc_count in the low five bits; then a marker byte, then cc_count triples.
  const ccCount = (payload[8] as number) & 0x1f;
  let cursor = 10;
  for (let i = 0; i < ccCount; i += 1) {
    if (cursor + 3 > payload.byteLength) break;
    const flags = payload[cursor] as number;
    const ccValid = (flags & 0x04) !== 0;
    const ccType = flags & 0x03;
    const a = payload[cursor + 1] as number;
    const b = payload[cursor + 2] as number;
    cursor += 3;
    if (ccValid) out.push({ type: ccType, a, b });
  }
}
