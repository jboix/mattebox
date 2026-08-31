import { afterEach, describe, expect, it } from 'vitest';
import { type CcPacket, registerCaptionConsumer } from '../../../src/containers/captions.js';
import {
  type TrackConfig,
  writeInitSegment,
  writeMediaSegment,
} from '../../../src/containers/fmp4/writer.js';
import nalScan from '../../../src/stages/nal-scan/index.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

/** A SEI NAL carrying one field-1 cc triple, length-prefixed as an AVCC sample. */
function seiSample(a: number, b: number): Uint8Array {
  const userData = [0xb5, 0x00, 0x31, 0x47, 0x41, 0x39, 0x34, 0x03, 0xc1, 0xff, 0x04, a, b];
  const nal = new Uint8Array([0x06, 4, userData.length, ...userData, 0x80]);
  const out = new Uint8Array(4 + nal.byteLength);
  new DataView(out.buffer).setUint32(0, nal.byteLength);
  out.set(nal, 4);
  return out;
}

function captureContext(): { ctx: StageContext; steps: TransformStep[] } {
  const steps: TransformStep[] = [];
  const ctx = { registerTransform: (s: TransformStep) => steps.push(s) } as unknown as StageContext;
  return { ctx, steps };
}

const videoConfig: TrackConfig = {
  id: 1,
  kind: 'video',
  timescale: 90000,
  sps: new Uint8Array([0x67, 0x42, 0xc0, 0x1e]),
  pps: new Uint8Array([0x68, 0xce, 0x3c, 0x80]),
  width: 320,
  height: 180,
};

const meta: SegmentMeta = {
  trackId: 'sb:video',
  renditionId: 'v',
  contentType: 'video',
  seq: 0,
  start: 0,
  duration: 4,
  isInit: false,
};

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('nal-scan fMP4 caption route', () => {
  it('extracts SEI captions from an fMP4 mdat and times them from the fragment', async () => {
    const received: CcPacket[] = [];
    unregister = registerCaptionConsumer((packets) => received.push(...packets));

    const { ctx, steps } = captureContext();
    nalScan().install(ctx);
    const step = steps[0] as TransformStep;

    const init = writeInitSegment([videoConfig]);
    const media = writeMediaSegment(1, [
      {
        trackId: 1,
        baseMediaDecodeTime: 90000, // one second in
        samples: [{ data: seiSample(0x20, 0x21), duration: 3000, cts: 0, isKeyframe: true }],
      },
    ]);
    const segment = new Uint8Array(init.byteLength + media.byteLength);
    segment.set(init, 0);
    segment.set(media, init.byteLength);

    const out = await step.transform(segment, meta);
    // The bytes pass straight through, unmodified.
    expect(out).toBe(segment);
    expect(received).toHaveLength(1);
    expect(received[0]?.time).toBeCloseTo(1, 5); // 90000 / 90000
    expect(received[0]?.triples).toEqual([{ type: 0, a: 0x20, b: 0x21 }]);
  });

  it('does zero work and delivers nothing when no caption consumer is registered', async () => {
    // No registerCaptionConsumer: captionsWanted() is false.
    const received: CcPacket[] = [];
    const probe = registerCaptionConsumer((p) => received.push(...p));
    probe(); // immediately unregister, leaving no consumer

    const { ctx, steps } = captureContext();
    nalScan().install(ctx);
    const step = steps[0] as TransformStep;
    const bytes = writeInitSegment([videoConfig]);
    const out = await step.transform(bytes, meta);
    expect(out).toBe(bytes);
    expect(received).toHaveLength(0);
  });
});
