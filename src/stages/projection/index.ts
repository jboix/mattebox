/**
 * projection as a loadable stage: a 360° video's projection from its init
 * segment, for a rendition whose manifest states none. The boxes it reads
 * are in `containers/projection`. It hands what it finds to the kernel with
 * SET_PROJECTION, so the rendition carries `projection` as if the manifest
 * had said it, and a player reads one field whatever the source.
 *
 * The init segment arrives before the video has its first frame, so the
 * rendition carries the projection by the time the element fires
 * `loadedmetadata`. A projection the manifest states wins: the stage reads
 * nothing for that rendition.
 *
 * The same boxes say how a frame holds a picture for each eye, and the
 * stage hands that over with SET_FRAME_PACKING, under the same rules.
 */
import { readFramePacking, readProjection } from '../../containers/projection.js';
import { findRendition } from '../../kernel/presentation.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

export default function projection(): Stage {
  return {
    name: 'projection',
    provides: ['projection'],
    requires: ['mp4-box'],
    install(ctx) {
      ctx.registerTransform({
        name: 'projection',
        // Early, so it reads the init before any transmux rewraps it.
        order: 5,
        transform(data: Uint8Array, meta: SegmentMeta): Uint8Array {
          if (meta.contentType !== 'video' || !meta.isInit) return data;
          const site = findRendition(ctx.getState().presentation, meta.renditionId);
          if (site === null) return data;
          const { projection, framePacking } = site.rendition;
          const found = projection === undefined ? readProjection(data) : null;
          if (found !== null) {
            ctx.dispatch({
              type: 'SET_PROJECTION',
              renditionId: meta.renditionId,
              projection: found,
            });
          }
          const packing = framePacking === undefined ? readFramePacking(data) : null;
          if (packing !== null) {
            ctx.dispatch({
              type: 'SET_FRAME_PACKING',
              renditionId: meta.renditionId,
              framePacking: packing,
            });
          }
          return data;
        },
      });
    },
  };
}
