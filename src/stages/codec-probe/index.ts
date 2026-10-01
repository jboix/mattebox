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
 * manifest that does declare codecs still creates the buffer as declared.
 * When the init segment holds another codec or another profile, the stage
 * reports it once per rendition as a non-fatal MEDIA_CODEC_MISMATCH error:
 * Chrome can refuse the appends of a buffer typed with the wrong profile.
 */
import { codecMismatch, probeInitSegment } from '../../containers/codec-probe/index.js';
import { findRendition } from '../../kernel/presentation.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

declare module '../../index.js' {
  interface MatteboxNamespaces {
    codecProbe: CodecProbeApi;
  }
}

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
      // One report per source, rendition, and probed codec.
      const reported = new Set<string>();

      /** Reports an init segment whose codec is not the one its rendition declares. */
      function checkDeclared(codecs: readonly string[], renditionId: string): void {
        const presentation = ctx.getState().presentation;
        const declared = findRendition(presentation, renditionId)?.rendition.codecs ?? null;
        if (presentation === null || declared === null) return;
        const mismatch = codecMismatch(declared, codecs);
        if (mismatch === null) return;
        const key = `${presentation.id}|${renditionId}|${mismatch.probed}`;
        if (reported.has(key)) return;
        reported.add(key);
        ctx.emit('error', {
          category: 'media',
          code: 'MEDIA_CODEC_MISMATCH',
          fatal: false,
          recoverable: true,
          context: { renditionId, ...mismatch },
        });
      }
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
            checkDeclared(result.codecs, meta.renditionId);
          }
          return data;
        },
      });
    },
  };
}
