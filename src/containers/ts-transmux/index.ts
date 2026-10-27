/**
 * ts-transmux as a loadable stage. It contributes exactly one thing to the
 * engine: a transform step for MPEG-TS media bytes. The kernel learns nothing
 * about TS. The protocol adapter that fed a `video/mp2t` playlist learns
 * nothing either; the media playlist's segment bytes flow through the same
 * transform pipeline as everything else, and this step rewrites the ones that
 * are transport streams.
 *
 * The first segment of each timeline epoch, in any rendition, sets the
 * epoch's anchor: its first timestamp sits at its playlist start. So the
 * time probe reads a decode time equal to that start and the kernel settles
 * a zero timestampOffset: the same path as native CMAF, no special case.
 * Every later segment of the epoch, of every rendition, is placed from its
 * own timestamps against that anchor, which keeps the offset an encoder
 * put between separate audio and video renditions. Without the probe the kernel would apply
 * the manifest's prediction, which re-anchors a discontinuity the bytes
 * already carry at its presentation time, so the stage requires one.
 * `media-transform` marks the stage as a byte rewriter.
 *
 * The state it keeps between segments: each rendition's last H.264
 * parameter sets, for a segment cut mid-GOP that carries none, and each
 * epoch's anchor.
 */
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage, StageContext } from '../../types/stage.js';
import { captionsWanted, deliverCaptions } from '../captions.js';
import { id3Events } from '../id3.js';
import { deliverMetadata, metadataWanted } from '../metadata.js';
import { createTransmuxRunner, type TransmuxRunnerOptions } from './runner.js';
import { looksLikeTransportStream } from './sniff.js';
import { transmuxSource } from './source.js';
import type { ParameterSets, TimeAnchor, TransmuxTracks } from './transmux.js';

/** Runs after decrypt-class steps (lower order) and before caption extraction. */
const TRANSMUX_ORDER = 100;

/**
 * The least drift, in seconds, past which a segment's own timestamps lose to
 * its playlist start. An encoder's offset between audio and video is well
 * under a segment; a jump of more than a segment is a clock that restarted
 * without a discontinuity tag.
 */
const MIN_TOLERANCE = 2;

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
      const runner = createTransmuxRunner(options, transmuxSource);
      let announcedDrop = false;
      // By source and rendition: a new source may reuse a rendition id.
      const parameterSets = new Map<string, ParameterSets>();
      // By source and epoch. The first segment of an epoch sets the anchor
      // and the others wait for it, so two renditions starting together
      // cannot each set one.
      const anchors = new Map<string, Promise<TimeAnchor | null>>();
      let anchoredSource: string | null = null;
      ctx.registerTransform({
        name: 'ts-transmux',
        order: TRANSMUX_ORDER,
        async transform(data, meta) {
          // Only media, and only actual transport streams: an fMP4 segment
          // sniffs false and passes straight through, no Worker round-trip.
          if (meta.contentType !== 'video' && meta.contentType !== 'audio') return data;
          if (!looksLikeTransportStream(data)) return data;
          const source = ctx.getState().presentation?.id ?? '';
          const key = `${source}|${meta.renditionId}`;
          if (source !== anchoredSource) {
            anchors.clear();
            anchoredSource = source;
          }
          const epochKey = `${source}|${meta.epoch ?? ''}`;
          const kept = anchors.get(epochKey);
          let settle: ((anchor: TimeAnchor | null) => void) | null = null;
          if (kept === undefined) {
            anchors.set(
              epochKey,
              new Promise((resolve) => {
                settle = resolve;
              }),
            );
          }
          const anchor = kept === undefined ? null : await kept;
          // Only extract SEI captions when a caption stage is loaded, so a
          // caption-free composition pays nothing for them.
          const result = await runner
            .run(
              data,
              meta.start,
              captionsWanted(),
              tracksFor(ctx, meta),
              parameterSets.get(key) ?? null,
              { anchor, tolerance: Math.max(meta.duration, MIN_TOLERANCE) },
            )
            .catch((cause: unknown) => {
              // A failed first segment leaves the epoch without an anchor: the next one sets it.
              if (settle !== null) {
                anchors.delete(epochKey);
                (settle as (anchor: TimeAnchor | null) => void)(null);
              }
              throw cause;
            });
          if (settle !== null) {
            (settle as (anchor: TimeAnchor | null) => void)(result.anchor);
          } else if (result.anchor !== null && result.anchor !== anchor) {
            // A segment whose clock jumped set a new anchor for the segments after it.
            anchors.set(epochKey, Promise.resolve(result.anchor));
          }
          if (result.parameterSets !== null) parameterSets.set(key, result.parameterSets);
          if (result.captions.length > 0) deliverCaptions(result.captions);
          if (result.metadata.length > 0 && metadataWanted()) {
            deliverMetadata(id3Events(result.metadata));
          }
          if (result.droppedAudio && !announcedDrop) {
            // Once per composition: the fact belongs in the diagnostic trace,
            // but every segment of the variant would repeat it.
            announcedDrop = true;
            ctx.emit('transmux:dropped-audio', {
              trackId: meta.trackId,
              renditionId: meta.renditionId,
            });
          }
          // A transport stream that yields nothing must not reach the buffer as
          // raw TS: the parser would fail the element. Failing the segment
          // lets recovery skip it.
          if (result.bytes === null) {
            if (result.empty) throw new RangeError('transport stream segment holds no media');
            return data;
          }
          return result.bytes;
        },
      });
      return () => runner.dispose();
    },
  };
}
