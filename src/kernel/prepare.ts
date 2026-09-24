/**
 * The segment preparer sits between the transport and the reducer. Media
 * bytes pass through the transform pipeline (decrypt, transmux, caption
 * scan) and then the media-time probe, so the SEGMENT_LOADED fact the
 * reducer sees carries bytes the SourceBuffer accepts and the decode time
 * they start at. The reducer settles each epoch's timestampOffset from
 * that reading before it emits the append, which is why the pipeline runs
 * here and not on the append effect: the offset has to be known first,
 * and a decrypt step has to run before anything can read a clock.
 *
 * Manifests and cue segments pass through untouched; the deliver effect
 * runs the pipeline for cue bytes. Without transforms and without a probe
 * the fact is forwarded as it came, synchronously.
 */
import type { InflightRequest } from '../types/kernel.js';
import type { Fact, SegmentMeta } from '../types/messages.js';
import type { MediaTimeProbe, TransformStep } from '../types/stage.js';

export interface PreparerDeps {
  /** The registered transform steps, in pipeline order. Read per segment, so a stage installed later joins. */
  readonly transforms: () => readonly TransformStep[];
  readonly timeProbe: () => MediaTimeProbe | null;
  /** Correlates a token with its request record from kernel state. */
  readonly inflight: (token: string) => InflightRequest | undefined;
  readonly absorb: (fact: Fact) => void;
}

/**
 * The boundary meta a transform and the probe receive. The content type
 * comes from the buffer the request names, so the preparer needs no
 * presentation lookup.
 */
function metaFor(request: InflightRequest): SegmentMeta {
  return {
    trackId: request.trackId,
    renditionId: request.renditionId ?? '',
    contentType: request.sbId === 'sb:audio' ? 'audio' : 'video',
    seq: request.seq,
    start: request.segmentStart ?? 0,
    duration: request.segmentDuration ?? 0,
    isInit: request.seq < 0,
  };
}

/** The bytes as one ArrayBuffer, copied only when the view does not cover its buffer. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? (data.buffer as ArrayBuffer)
    : (data.slice().buffer as ArrayBuffer);
}

/** Wraps `absorb`: the returned function takes the transport's facts and forwards them prepared. */
export function createSegmentPreparer(deps: PreparerDeps): (fact: Fact) => void {
  // One chain per buffer: a slow transform on segment N must not let
  // segment N+1 reach the reducer first.
  const chains = new Map<string, Promise<void>>();
  return (fact) => {
    if (fact.type !== 'SEGMENT_LOADED' || fact.token === undefined) {
      deps.absorb(fact);
      return;
    }
    const request = deps.inflight(fact.token);
    if (request?.sbId === undefined) {
      deps.absorb(fact);
      return;
    }
    const steps = deps.transforms();
    const probe = deps.timeProbe();
    if (steps.length === 0 && probe === null) {
      deps.absorb(fact);
      return;
    }
    const meta = metaFor(request);
    const sbId = request.sbId;
    const prior = chains.get(sbId) ?? Promise.resolve();
    const next = prior
      .then(async () => {
        let data = new Uint8Array(fact.bytes);
        for (const step of steps) data = new Uint8Array(await step.transform(data, meta));
        // An init segment carries no decode time, but the probe sees it so
        // it can learn the track timescales the media segments need.
        let mediaStart: number | null = null;
        if (probe !== null) {
          try {
            mediaStart = probe(data, meta);
          } catch {
            mediaStart = null;
          }
        }
        deps.absorb({
          ...fact,
          bytes: toArrayBuffer(data),
          ...(mediaStart !== null && request.seq >= 0 ? { mediaStart } : {}),
        });
      })
      .catch((err: unknown) => {
        // A transform failure is a container error on this segment, never
        // a throw or a hang: the request closes and the loop moves on.
        deps.absorb({
          type: 'SEGMENT_FAILED',
          trackId: request.trackId,
          seq: request.seq,
          ...(request.renditionId !== undefined ? { renditionId: request.renditionId } : {}),
          error: {
            category: 'media',
            code: 'MEDIA_CONTAINER_INVALID',
            fatal: false,
            recoverable: false,
            context: { message: String(err), token: fact.token },
          },
        });
      });
    chains.set(sbId, next);
  };
}
