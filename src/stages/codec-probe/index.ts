/**
 * codec-probe as a loadable stage. The derivation itself lives in the
 * container layer (probeInitSegment reads the stsd sample entries and rebuilds
 * the RFC 6381 string from avcC/hvcC/esds/vpcC/dOps). This stage is the
 * runtime call site the container never had: a transform that watches init
 * segments, publishes what it derived on `engine.codecProbe`, and emits a
 * `codecprobe:detected` event.
 *
 * It also registers the composition's type probe: a rendition the manifest
 * left codec-less (a bare media playlist) gets its SourceBuffer typed from
 * its first segment instead of the bare `video/mp4` Chrome refuses. A
 * manifest that does declare codecs still creates the buffer as declared;
 * a mismatch with the probe surfaces on the event for a follow-up stage.
 */
import { probeInitSegment } from '../../containers/codec-probe/index.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

export interface CodecProbeApi {
  /** The codec strings derived from the most recent init segment. */
  readonly detected: readonly string[];
  /** The MSE mime type the probe reconstructed, ready for isTypeSupported. */
  readonly mimeType: string | null;
}

/** A media segment carries a moof; only an init segment carries a moov. */
function isInitSegment(data: Uint8Array): boolean {
  for (let i = 4; i + 4 <= data.byteLength && i < 64; i += 1) {
    if (data[i] === 0x6d && data[i + 1] === 0x6f && data[i + 2] === 0x6f && data[i + 3] === 0x76) {
      return true; // 'moov'
    }
  }
  return false;
}

export default function codecProbe(): Stage {
  return {
    name: 'codec-probe',
    provides: ['codec-probe'],
    requires: ['mp4-box'],
    install(ctx) {
      let detected: readonly string[] = [];
      let mimeType: string | null = null;
      ctx.registerNamespace('codecProbe', {
        get detected() {
          return detected;
        },
        get mimeType() {
          return mimeType;
        },
      } satisfies CodecProbeApi);
      ctx.registerTypeProbe((bytes) => {
        if (!isInitSegment(bytes)) return null;
        const result = probeInitSegment(bytes);
        return result.codecs.length > 0 ? result.mimeType : null;
      });
      ctx.registerTransform({
        name: 'codec-probe',
        // Early, so it reads the init before any transmux rewraps it.
        order: 5,
        transform(data: Uint8Array, meta: SegmentMeta): Uint8Array {
          if (meta.contentType !== 'video' && meta.contentType !== 'audio') return data;
          if (!isInitSegment(data)) return data;
          const result = probeInitSegment(data);
          if (result.codecs.length > 0) {
            detected = result.codecs;
            mimeType = result.mimeType;
            ctx.emit('codecprobe:detected', { codecs: result.codecs, mimeType: result.mimeType });
          }
          return data;
        },
      });
    },
  };
}
