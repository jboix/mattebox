import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { initialState } from '../../../src/kernel/reducer.js';
import aes128, { ivFor } from '../../../src/stages/aes-128/index.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

const KEY_URL = 'https://keys.example/k1.bin';
const KEY_BYTES = new Uint8Array(16).map((_, i) => i * 7 + 1);

function presentation(): Presentation {
  return {
    id: 'p',
    isLive: false,
    duration: 30,
    periods: [
      {
        id: 'p0',
        start: 0,
        tracks: [
          {
            id: 'v',
            contentType: 'video',
            mimeType: 'video/mp4',
            protection: null,
            renditions: [
              {
                id: 'r-0',
                bitrate: 0,
                codecs: null,
                mimeType: 'video/mp4',
                segments: [
                  {
                    seq: 5,
                    start: 0,
                    duration: 10,
                    url: 'https://cdn.example/5.ts',
                    key: { method: 'AES-128', uri: KEY_URL },
                  },
                  {
                    seq: 6,
                    start: 10,
                    duration: 10,
                    url: 'https://cdn.example/6.ts',
                    key: {
                      method: 'AES-128',
                      uri: KEY_URL,
                      iv: '000102030405060708090a0b0c0d0e0f',
                    },
                  },
                  { seq: 7, start: 20, duration: 10, url: 'https://cdn.example/7.ts' },
                ],
              },
            ],
          },
        ],
      },
    ],
    couplings: [],
  };
}

function meta(seq: number): SegmentMeta {
  return {
    trackId: 'sb:video',
    renditionId: 'r-0',
    contentType: 'video',
    seq,
    start: 0,
    duration: 10,
    isInit: false,
  };
}

async function encrypt(clear: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const key = await webcrypto.subtle.importKey('raw', KEY_BYTES, { name: 'AES-CBC' }, false, [
    'encrypt',
  ]);
  return new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, clear));
}

function install(state: KernelState): {
  step: TransformStep;
  requests: string[];
  teardown: () => void;
} {
  const steps: TransformStep[] = [];
  const requests: string[] = [];
  const ctx = {
    registerTransform: (s: TransformStep) => steps.push(s),
    getState: () => state,
    request: async (url: string) => {
      requests.push(url);
      return new Response(KEY_BYTES);
    },
  } as unknown as StageContext;
  const teardown = aes128().install(ctx) as () => void;
  return { step: steps[0] as TransformStep, requests, teardown };
}

describe('aes-128', () => {
  const state: KernelState = { ...initialState(), presentation: presentation() };
  const clear = new TextEncoder().encode('clear transport stream bytes, not a multiple of sixteen');

  it('decrypts a keyed segment with the sequence-number IV, and caches the key', async () => {
    const { step, requests } = install(state);
    expect(step.order).toBeLessThan(5);
    const cipher = await encrypt(clear, ivFor({ method: 'AES-128', uri: KEY_URL }, 5));
    expect(cipher).not.toEqual(clear);
    const out = await step.transform(cipher, meta(5));
    expect(new Uint8Array(out)).toEqual(clear);
    await step.transform(cipher, meta(5));
    expect(requests).toEqual([KEY_URL]);
  });

  it('uses the explicit IV when the playlist carries one', async () => {
    const { step } = install(state);
    const iv = new Uint8Array(16).map((_, i) => i);
    const cipher = await encrypt(clear, iv);
    expect(new Uint8Array(await step.transform(cipher, meta(6)))).toEqual(clear);
  });

  it('passes an unkeyed segment through untouched', async () => {
    const { step, requests } = install(state);
    const out = await step.transform(clear, meta(7));
    expect(out).toBe(clear);
    expect(requests).toEqual([]);
  });

  it('the sequence-number IV is big-endian in the last bytes', () => {
    const iv = ivFor({ method: 'AES-128', uri: KEY_URL }, 0x01020304);
    expect([...iv.slice(0, 12)]).toEqual(new Array(12).fill(0));
    expect([...iv.slice(12)]).toEqual([1, 2, 3, 4]);
    expect([...ivFor({ method: 'AES-128', uri: KEY_URL, iv: '1f' }, 9)].at(-1)).toBe(0x1f);
  });
});
