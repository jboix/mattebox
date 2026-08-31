import type { InflightRequest, KernelState, Presentation } from '../../../src/index.js';
import { initialState } from '../../../src/kernel/reducer.js';

/**
 * Recursively freezes a state tree, including Maps, whose mutators are
 * replaced with throwing functions. Any reducer that mutates its input then
 * fails the test instead of passing by accident.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Map) {
    for (const [k, v] of value) {
      deepFreeze(k);
      deepFreeze(v);
    }
    const forbid = () => {
      throw new Error('mutation of a frozen Map');
    };
    value.set = forbid;
    value.delete = forbid;
    value.clear = forbid;
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export const vodFixture: Presentation = {
  id: 'vod-1',
  isLive: false,
  duration: 600,
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
              id: 'v-1',
              bitrate: 800_000,
              width: 1280,
              height: 720,
              codecs: 'avc1.64001f',
              mimeType: 'video/mp4',
              segments: [
                { seq: 0, start: 0, duration: 4, url: 'https://cdn.example/v1/0.m4s' },
                { seq: 1, start: 4, duration: 4, url: 'https://cdn.example/v1/1.m4s' },
              ],
            },
          ],
        },
        {
          id: 'a',
          contentType: 'audio',
          mimeType: 'audio/mp4',
          lang: 'de',
          protection: null,
          renditions: [
            {
              id: 'a-1',
              bitrate: 128_000,
              codecs: 'mp4a.40.2',
              mimeType: 'audio/mp4',
              segments: [{ seq: 0, start: 0, duration: 4, url: 'https://cdn.example/a1/0.m4s' }],
            },
          ],
        },
      ],
    },
  ],
  couplings: [],
};

/** A ready-phase state with a segment fetch in flight, the docs-11 scenario. */
export function readyStateWithInflight(inflight: readonly InflightRequest[]): KernelState {
  const base = initialState();
  return {
    ...base,
    lifecycle: { phase: 'ready' },
    presentation: vodFixture,
    buffers: new Map([['sb-v', { codecs: 'avc1.64001f', ranges: [], pendingAppends: 0 }]]),
    scheduling: {
      ...base.scheduling,
      inflight: new Map(inflight.map((request) => [request.token, request])),
      tokenSeq: inflight.length,
    },
    tracks: { active: new Map([['video', 'v']]), available: ['v', 'a'] },
  };
}
