/**
 * The caption seam of entanglement #1. Two sources reach in-band captions:
 * ts-transmux, which already splits NALs in its Worker and returns the SEI
 * caption bytes it finds, and nal-scan, which walks an fMP4 mdat for the same
 * bytes. Both deliver here; text-cea608 registers the one consumer that
 * decodes them. Nobody imports text-cea608 to do it, and when no caption
 * stage has registered, `wanted()` is false and neither source does the work.
 */
import type { CcTriple } from './sei.js';

/** One access unit's caption triples at its presentation time, in seconds. */
export interface CcPacket {
  readonly time: number;
  readonly triples: readonly CcTriple[];
}

export type CaptionConsumer = (packets: readonly CcPacket[]) => void;

let consumer: CaptionConsumer | null = null;
let lastFingerprint = '';

/** Registers the caption decoder. Returns an unregister for stage teardown. */
export function registerCaptionConsumer(fn: CaptionConsumer): () => void {
  consumer = fn;
  lastFingerprint = '';
  return () => {
    if (consumer === fn) consumer = null;
  };
}

/** True when a caption stage is loaded, so a SEI source should extract. */
export function captionsWanted(): boolean {
  return consumer !== null;
}

function fingerprint(packets: readonly CcPacket[]): string {
  const first = packets[0];
  const last = packets[packets.length - 1];
  return `${packets.length}:${first?.time}:${first?.triples[0]?.a}:${last?.time}:${last?.triples[0]?.b}`;
}

/**
 * Hands extracted caption packets to the registered decoder. When both a
 * ts-transmux and a nal-scan source are composed they extract the same SEI
 * from the same segment back to back; an identical batch arriving twice in a
 * row is dropped so the decoder never sees a caption doubled.
 */
export function deliverCaptions(packets: readonly CcPacket[]): void {
  if (packets.length === 0 || consumer === null) return;
  const print = fingerprint(packets);
  if (print === lastFingerprint) return;
  lastFingerprint = print;
  consumer(packets);
}
