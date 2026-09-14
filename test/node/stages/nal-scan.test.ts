import { readFileSync } from 'node:fs';
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

/** ATSC A/53 caption user data with one field-1 cc triple, as payloadType 4, size, body. */
function captionMessage(a: number, b: number): number[] {
  const userData = [0xb5, 0x00, 0x31, 0x47, 0x41, 0x39, 0x34, 0x03, 0xc1, 0xff, 0x04, a, b];
  return [4, userData.length, ...userData];
}

/** An H.264 SEI NAL: one header byte, the message, the RBSP stop bit. */
function avcSei(a: number, b: number): number[] {
  return [0x06, ...captionMessage(a, b), 0x80];
}

/** An HEVC prefix SEI NAL: two header bytes (type 39, temporal id 1). */
function hevcSei(a: number, b: number): number[] {
  return [0x4e, 0x01, ...captionMessage(a, b), 0x80];
}

const AVC_IDR = [0x65, 0x88, 0x84, 0x00];

/** NAL units as one sample, each behind a 4-byte length prefix. */
function sample(...nals: readonly number[][]): Uint8Array {
  const out = new Uint8Array(nals.reduce((sum, nal) => sum + 4 + nal.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const nal of nals) {
    view.setUint32(at, nal.length);
    out.set(nal, at + 4);
    at += 4 + nal.length;
  }
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function installScan(): TransformStep {
  const steps: TransformStep[] = [];
  const ctx = { registerTransform: (s: TransformStep) => steps.push(s) } as unknown as StageContext;
  nalScan().install(ctx);
  return steps[0] as TransformStep;
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

const audioConfig: TrackConfig = {
  id: 1,
  kind: 'audio',
  timescale: 48000,
  audioObjectType: 2,
  samplingFrequencyIndex: 3,
  channelConfig: 2,
};

const meta: SegmentMeta = {
  trackId: 'sb:video',
  renditionId: 'v',
  contentType: 'video',
  seq: 0,
  start: 10,
  duration: 4,
  isInit: false,
};

/** An audio track 1 whose samples look like SEI, and the video as track 2. */
function muxedSegment(): Uint8Array {
  return concat(
    writeInitSegment([audioConfig, { ...videoConfig, id: 2 }]),
    writeMediaSegment(1, [
      {
        trackId: 1,
        baseMediaDecodeTime: 0,
        samples: [{ data: sample(avcSei(0x11, 0x12)), duration: 1024, cts: 0, isKeyframe: true }],
      },
      {
        trackId: 2,
        baseMediaDecodeTime: 0,
        samples: [{ data: sample(avcSei(0x20, 0x21)), duration: 3000, cts: 0, isKeyframe: true }],
      },
    ]),
  );
}

let received: CcPacket[] = [];
let unregister: (() => void) | null = null;

function listen(): void {
  received = [];
  unregister = registerCaptionConsumer((packets) => received.push(...packets));
}

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('nal-scan fMP4 caption route', () => {
  it('extracts H.264 SEI captions timed from the segment start, not the tfdt', async () => {
    listen();
    const step = installScan();
    const segment = concat(
      writeInitSegment([videoConfig]),
      writeMediaSegment(1, [
        {
          trackId: 1,
          // A broadcast clock, as live packagers write it.
          baseMediaDecodeTime: 1_700_000_000 * 90000,
          samples: [
            { data: sample(AVC_IDR), duration: 3000, cts: 3000, isKeyframe: true },
            {
              data: sample(avcSei(0x20, 0x21), AVC_IDR),
              duration: 3000,
              cts: 3000,
              isKeyframe: false,
            },
          ],
        },
      ]),
    );

    const out = await step.transform(segment, meta);
    // The bytes pass straight through, unmodified.
    expect(out).toBe(segment);
    expect(received).toHaveLength(1);
    // Second sample: 3000 decode offset plus 3000 composition offset, at 90 kHz.
    expect(received[0]?.time).toBeCloseTo(10 + 6000 / 90000, 6);
    expect(received[0]?.triples).toEqual([{ type: 0, a: 0x20, b: 0x21 }]);
  });

  it('reads HEVC SEI units and skips HEVC NALs whose first byte looks like H.264 SEI', async () => {
    listen();
    const step = installScan();
    const init = new Uint8Array(
      readFileSync(new URL('../../fixtures/segments/init-v-hevc.mp4', import.meta.url)),
    );
    // 0x26 is an HEVC IDR_W_RADL slice header; its low five bits read 6, H.264's SEI type.
    const idrDecoy = [0x26, ...captionMessage(0x11, 0x12), 0x80];
    const media = writeMediaSegment(1, [
      {
        trackId: 1,
        baseMediaDecodeTime: 0,
        samples: [
          { data: sample(idrDecoy, hevcSei(0x20, 0x21)), duration: 1, cts: 0, isKeyframe: true },
        ],
      },
    ]);

    await step.transform(concat(init, media), meta);
    expect(received).toHaveLength(1);
    expect(received[0]?.time).toBe(10);
    expect(received[0]?.triples).toEqual([{ type: 0, a: 0x20, b: 0x21 }]);
  });

  it('scans only the video track of a muxed segment', async () => {
    listen();
    const step = installScan();
    await step.transform(muxedSegment(), meta);
    expect(received).toHaveLength(1);
    expect(received[0]?.triples).toEqual([{ type: 0, a: 0x20, b: 0x21 }]);
  });

  it('ignores an audio buffer', async () => {
    listen();
    const step = installScan();
    await step.transform(muxedSegment(), { ...meta, trackId: 'sb:audio', contentType: 'audio' });
    expect(received).toHaveLength(0);
  });

  it('runs before ts-transmux and leaves a transport stream to it', async () => {
    listen();
    const step = installScan();
    // ts-transmux registers at order 100 and delivers its own captions.
    expect(step.order).toBeLessThan(100);
    const packet = new Uint8Array(188);
    packet[0] = 0x47;
    const out = await step.transform(packet, meta);
    expect(out).toBe(packet);
    expect(received).toHaveLength(0);
  });

  it('returns a truncated segment unchanged without throwing', async () => {
    listen();
    const step = installScan();
    const truncated = muxedSegment().subarray(0, -12);
    expect(await step.transform(truncated, meta)).toBe(truncated);
  });

  it('does no work and delivers nothing when no caption consumer is registered', async () => {
    const captured: CcPacket[] = [];
    const probe = registerCaptionConsumer((p) => captured.push(...p));
    probe(); // immediately unregister, leaving no consumer

    const step = installScan();
    const bytes = muxedSegment();
    const out = await step.transform(bytes, meta);
    expect(out).toBe(bytes);
    expect(captured).toHaveLength(0);
  });
});
