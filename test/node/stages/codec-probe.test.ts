import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import codecProbe from '../../../src/stages/codec-probe/index.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

// avc1.64000d: High profile.
const HIGH = new Uint8Array(
  readFileSync(join(import.meta.dirname, '../../fixtures/segments/init-v-high.mp4')),
);

function install(declared: string | null) {
  const errors: unknown[] = [];
  let step: TransformStep | null = null;
  const state = {
    presentation: {
      id: 'https://cdn.example/master.m3u8',
      isLive: false,
      couplings: [],
      periods: [
        {
          id: 'p0',
          start: 0,
          tracks: [
            {
              id: 'video',
              contentType: 'video',
              mimeType: 'video/mp4',
              protection: null,
              renditions: [
                { id: 'v1', bitrate: 1, codecs: declared, mimeType: 'video/mp4', segments: [] },
              ],
            },
          ],
        },
      ],
    },
  } as unknown as KernelState;
  codecProbe().install({
    registerNamespace: () => undefined,
    registerTypeProbe: () => undefined,
    registerTransform: (s: TransformStep) => {
      step = s;
    },
    getState: () => state,
    emit: (event: string, payload: unknown) => {
      if (event === 'error') errors.push(payload);
    },
  } as unknown as StageContext);
  const meta: SegmentMeta = {
    trackId: 'video',
    renditionId: 'v1',
    contentType: 'video',
    seq: 0,
    start: 0,
    duration: 0,
    isInit: true,
  };
  const transform = (step as unknown as TransformStep).transform;
  return { errors, append: () => transform(HIGH, meta) };
}

describe('codec-probe reports a declared codec the init segment contradicts', () => {
  it('Main declared for a High init: one MEDIA_CODEC_MISMATCH, non-fatal', () => {
    const { errors, append } = install('avc1.4d401f');
    append();
    append();
    expect(errors).toEqual([
      {
        category: 'media',
        code: 'MEDIA_CODEC_MISMATCH',
        fatal: false,
        recoverable: true,
        context: {
          renditionId: 'v1',
          kind: 'profile',
          declared: 'avc1.4d401f',
          probed: 'avc1.64000d',
        },
      },
    ]);
  });

  it('a level-only difference and a codec-less rendition stay quiet', () => {
    const level = install('avc1.64001f');
    level.append();
    expect(level.errors).toEqual([]);
    const bare = install(null);
    bare.append();
    expect(bare.errors).toEqual([]);
  });
});
