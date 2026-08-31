/**
 * ts-transmux as a loadable stage. It contributes exactly one thing to the
 * engine: a transform step for MPEG-TS media bytes. The kernel learns nothing
 * about TS. The protocol adapter that fed a `video/mp2t` playlist learns
 * nothing either; the media playlist's segment bytes flow through the same
 * transform pipeline as everything else, and this step rewrites the ones that
 * are transport streams.
 *
 * The `media-transform` capability is what tells the composition root to wire
 * the append path through the transform pipeline; `media-time-normalized`
 * tells the scheduler the rewritten media time equals presentation time. A
 * CMAF composition never provides either, so its append path is untouched.
 */
import type { Stage } from '../../types/stage.js';
import { captionsWanted, deliverCaptions } from '../captions.js';
import { looksLikeTransportStream } from './demux.js';
import { createTransmuxRunner, type TransmuxRunnerOptions } from './runner.js';

/** Runs after decrypt-class steps (lower order) and before caption extraction. */
const TRANSMUX_ORDER = 100;

export default function tsTransmux(options: TransmuxRunnerOptions = {}): Stage {
  return {
    name: 'ts-transmux',
    provides: ['ts-transmux', 'media-transform', 'media-time-normalized'],
    install(ctx) {
      const runner = createTransmuxRunner(options);
      ctx.registerTransform({
        name: 'ts-transmux',
        order: TRANSMUX_ORDER,
        async transform(data, meta) {
          // Only media, and only actual transport streams: an fMP4 segment
          // sniffs false and passes straight through, no Worker round-trip.
          if (meta.contentType !== 'video' && meta.contentType !== 'audio') return data;
          if (!looksLikeTransportStream(data)) return data;
          // Only extract SEI captions when a caption stage is loaded, so a
          // caption-free composition pays nothing for them.
          const result = await runner.run(data, meta.start, captionsWanted());
          if (result.captions.length > 0) deliverCaptions(result.captions);
          return result.bytes ?? data;
        },
      });
      return () => runner.dispose();
    },
  };
}
