/**
 * cmaf-timing normalizes the decode timeline of native fMP4 segments so a live
 * CMAF stream plays. A CMAF live segment's tfdt carries the real broadcast
 * clock (often a value in the billions of seconds); appended with the zero
 * timestampOffset the kernel derives for fMP4, its frames land far past the
 * playhead and nothing ever renders. This stage rewrites each segment's tfdt to
 * the presentation start the manifest assigns it, which is the same alignment a
 * TS transmux produces for free, so VOD (already near zero) is untouched and
 * live is corrected.
 *
 * It contributes a transform step and the `media-transform` capability, so the
 * append path routes through the transform pipeline for a CMAF composition too.
 * Timescales come from the init segment's moov; the transform runs after any
 * transmux, and a decrypt step never touches the moof header, so an encrypted
 * segment is normalized the same way.
 */
import { findBox, normalizeTfdt, trackTimescales } from '../../containers/mp4-box/index.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

/** After ts-transmux (100) and any decrypt-class step, before the append. */
const ORDER = 150;

export default function cmafTiming(): Stage {
  return {
    name: 'cmaf-timing',
    provides: ['cmaf-timing', 'media-transform', 'media-time-normalized'],
    install(ctx) {
      // Track-id to timescale, learned from init segments, per content type.
      const timescales = new Map<string, Map<number, number>>();
      ctx.registerTransform({
        name: 'cmaf-timing',
        order: ORDER,
        transform(data: Uint8Array, meta: SegmentMeta): Uint8Array {
          if (meta.contentType !== 'video' && meta.contentType !== 'audio') return data;
          // An init segment carries the moov: learn each track's timescale.
          if (findBox(data, 'moov') !== null) {
            const scales = trackTimescales(data);
            if (scales.size > 0) timescales.set(meta.contentType, scales);
          }
          // A media segment carries a moof: align its decode clock to the
          // presentation start the manifest gave it. Without a known timescale
          // (no init seen yet) leave the bytes alone rather than guess.
          if (findBox(data, 'moof') !== null) {
            const scales = timescales.get(meta.contentType);
            if (scales !== undefined && scales.size > 0) {
              const fallback = [...scales.values()][0] ?? 0;
              normalizeTfdt(data, meta.start, scales, fallback);
            }
          }
          return data;
        },
      });
      return undefined;
    },
  };
}
