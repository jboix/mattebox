/**
 * ts-transmux as a loadable stage. It contributes exactly one thing to the
 * engine: a transform step for MPEG-TS media bytes. The kernel learns nothing
 * about TS. The protocol adapter that fed a `video/mp2t` playlist learns
 * nothing either; the media playlist's segment bytes flow through the same
 * transform pipeline as everything else, and this step rewrites the ones that
 * are transport streams.
 *
 * The transmux writes each segment's baseMediaDecodeTime at its playlist
 * start, so the time probe reads a decode time equal to the presentation
 * start and the kernel settles a zero timestampOffset: the same path as
 * native CMAF, no special case. Without the probe the kernel would apply
 * the manifest's prediction, which re-anchors a discontinuity the bytes
 * already carry at its presentation time, so the stage requires one.
 * `media-transform` marks the stage as a byte rewriter.
 */
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage, StageContext } from '../../types/stage.js';
import { captionsWanted, deliverCaptions } from '../captions.js';
import { looksLikeTransportStream } from './demux.js';
import { createTransmuxRunner, type TransmuxRunnerOptions } from './runner.js';
import type { TransmuxTracks } from './transmux.js';

/** Runs after decrypt-class steps (lower order) and before caption extraction. */
const TRANSMUX_ORDER = 100;

/**
 * Which elementary streams a segment's buffer should receive. A video
 * segment keeps only its video stream once the kernel has an audio track of
 * its own active: the audio is then a separate rendition on sb:audio, so a
 * variant that muxes audio anyway (Akamai-packaged catalogs commonly do)
 * must not hand the video buffer an undeclared audio track. Without a
 * separate audio track the muxed audio is the only audio, so keep both.
 */
function tracksFor(ctx: StageContext, meta: SegmentMeta): TransmuxTracks {
  if (meta.contentType === 'audio') return 'audio';
  return ctx.getState().tracks.active.has('audio') ? 'video' : 'all';
}

export default function tsTransmux(options: TransmuxRunnerOptions = {}): Stage {
  return {
    name: 'ts-transmux',
    provides: ['ts-transmux', 'media-transform'],
    requires: ['media-time-probe'],
    install(ctx) {
      const runner = createTransmuxRunner(options);
      let announcedDrop = false;
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
          const result = await runner.run(data, meta.start, captionsWanted(), tracksFor(ctx, meta));
          if (result.captions.length > 0) deliverCaptions(result.captions);
          if (result.droppedAudio && !announcedDrop) {
            // Once per composition: the fact belongs in the diagnostic trace,
            // but every segment of the variant would repeat it.
            announcedDrop = true;
            ctx.emit('transmux:dropped-audio', {
              trackId: meta.trackId,
              renditionId: meta.renditionId,
            });
          }
          return result.bytes ?? data;
        },
      });
      return () => runner.dispose();
    },
  };
}
