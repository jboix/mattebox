import { describe, expect, it } from 'vitest';
import { schedule } from '../../../src/kernel/scheduler.js';
import type { Period, Rendition } from '../../../src/types/ir.js';

// A live window with a discontinuity 20 s in: the second epoch's media clock
// restarts, so the epoch arithmetic offsets its appends by their start.
const rendition: Rendition = {
  id: 'a',
  bitrate: 192_000,
  codecs: 'mp4a.40.2',
  mimeType: 'video/mp2t',
  segments: [
    { seq: 0, start: 0, duration: 10, url: 'u0' },
    { seq: 1, start: 10, duration: 10, url: 'u1' },
    { seq: 2, start: 20, duration: 10, url: 'u2', discontinuity: true },
    { seq: 3, start: 30, duration: 10, url: 'u3' },
  ],
};
const period: Period = {
  id: 'p',
  start: 0,
  tracks: [
    {
      id: 't',
      contentType: 'audio',
      mimeType: 'video/mp2t',
      protection: null,
      renditions: [rendition],
    },
  ],
};

function input(currentTime: number, mediaTimeNormalized?: boolean) {
  return {
    currentTime,
    bufferGoal: 30,
    tokenSeq: 0,
    tracks: [{ trackId: 't', period, rendition, ranges: [], sbId: 'sb:audio', inflight: [] }],
    ...(mediaTimeNormalized !== undefined ? { mediaTimeNormalized } : {}),
  };
}

describe('scheduler: timestamp offset after a discontinuity', () => {
  it('raw media re-anchors at the discontinuity start', () => {
    const { requests } = schedule(input(31));
    expect(requests[0]).toMatchObject({ seq: 3, timestampOffset: 20 });
  });

  it('normalized media keeps a zero offset, since the bytes already carry presentation time', () => {
    const { requests } = schedule(input(31, true));
    expect(requests[0]).toMatchObject({ seq: 3, timestampOffset: 0 });
    const before = schedule(input(11, true));
    expect(before.requests[0]).toMatchObject({ seq: 1, timestampOffset: 0 });
  });
});
