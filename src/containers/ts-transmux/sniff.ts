/**
 * Whether bytes are an MPEG-TS segment. Its own module so the stage can sniff
 * every segment without loading the demux, which the npm build then splits
 * into the chunk the main thread loads only when the Worker is not used.
 */

/** ISO/IEC 13818-1 §2.4.3.2: every transport packet is 188 bytes and starts with 0x47. */
export const PACKET_SIZE = 188;
export const SYNC_BYTE = 0x47;

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
