/**
 * cmaf-timing reads where a native fMP4 segment's media clock starts, so
 * the kernel can land the segment at the presentation time the manifest
 * gives it. Packagers write whatever clock they like into tfdt: a live
 * broadcast clock in the billions of seconds, an encoder offset of ten
 * seconds into a VOD title, or zero. The bytes are never touched. The
 * kernel settles one timestampOffset per timeline epoch from the first
 * reading, the segment's playlist start minus this decode time, and every
 * buffer applies it, the way videojs-http-streaming derives the offset
 * from its main loader's first segment.
 *
 * The probe runs after the transform pipeline, so a decrypted or
 * transmuxed segment is read in its final form. Timescales come from each
 * rendition's init segment moov, or from a self-contained segment that
 * carries its own.
 */
import { earliestDecodeTime, findBox, trackTimescales } from '../../containers/mp4-box/index.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

export default function cmafTiming(): Stage {
  return {
    name: 'cmaf-timing',
    provides: ['cmaf-timing', 'media-time-probe'],
    install(ctx) {
      // Track-id to timescale, learned from init segments, per rendition:
      // two renditions of one track may be packaged on different clocks.
      const timescales = new Map<string, ReadonlyMap<number, number>>();
      ctx.registerTimeProbe((data: Uint8Array, meta: SegmentMeta): number | null => {
        if (meta.contentType !== 'video' && meta.contentType !== 'audio') return null;
        if (findBox(data, 'moov') !== null) {
          const scales = trackTimescales(data);
          if (scales.size > 0) timescales.set(meta.renditionId, scales);
        }
        if (findBox(data, 'moof') === null) return null;
        // Without a known timescale (no init seen yet) report nothing
        // rather than guess; the kernel then keeps the manifest's prediction.
        const scales = timescales.get(meta.renditionId);
        if (scales === undefined) return null;
        return earliestDecodeTime(data, scales);
      });
      return undefined;
    },
  };
}
