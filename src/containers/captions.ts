/**
 * The caption seam of entanglement #1. Two sources reach in-band captions:
 * ts-transmux, which already splits NALs in its Worker and returns the SEI
 * caption bytes it finds, and nal-scan, which walks an fMP4 mdat for the same
 * bytes. Both deliver here; text-cea608 and text-cea708 each register a
 * consumer and read the cc_type values they decode, so a SEI is parsed once
 * for both. Nobody imports a caption stage to do it, and when none has
 * registered, `captionsWanted()` is false and neither source does the work.
 */
import type { CcTriple } from './sei.js';

/** One access unit's caption triples at its presentation time, in seconds. */
export interface CcPacket {
  readonly time: number;
  readonly triples: readonly CcTriple[];
}

export type CaptionConsumer = (packets: readonly CcPacket[]) => void;

const consumers = new Set<CaptionConsumer>();
let lastFingerprint = '';

/** Registers a caption decoder. Returns an unregister for stage teardown. */
export function registerCaptionConsumer(fn: CaptionConsumer): () => void {
  consumers.add(fn);
  lastFingerprint = '';
  return () => {
    consumers.delete(fn);
  };
}

/** True when a caption stage is loaded, so a SEI source should extract. */
export function captionsWanted(): boolean {
  return consumers.size > 0;
}

function fingerprint(packets: readonly CcPacket[]): string {
  const first = packets[0];
  const last = packets[packets.length - 1];
  return `${packets.length}:${first?.time}:${first?.triples[0]?.a}:${last?.time}:${last?.triples[0]?.b}`;
}

/**
 * Hands extracted caption packets to every registered decoder. When both a
 * ts-transmux and a nal-scan source are composed they extract the same SEI
 * from the same segment back to back; an identical batch arriving twice in a
 * row is dropped so the decoder never sees a caption doubled.
 */
export function deliverCaptions(packets: readonly CcPacket[]): void {
  if (packets.length === 0 || consumers.size === 0) return;
  const print = fingerprint(packets);
  if (print === lastFingerprint) return;
  lastFingerprint = print;
  for (const consumer of consumers) consumer(packets);
}
