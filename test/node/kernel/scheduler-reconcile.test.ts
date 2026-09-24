import { describe, expect, it } from 'vitest';
import { schedule } from '../../../src/kernel/scheduler.js';
import type { Period, Rendition } from '../../../src/types/ir.js';

// Video and audio playlists of one period. Each numbers its own sequences
// and sums its own durations, so the discontinuity 20 s in lands at seq 2
// for video and seq 4 for audio, with starts a few milliseconds apart.
const video: Rendition = {
  id: 'v',
  bitrate: 800_000,
  codecs: 'avc1.64001f',
  mimeType: 'video/mp4',
  segments: [
    { seq: 0, start: 0, duration: 10, url: 'v0' },
    { seq: 1, start: 10, duration: 10, url: 'v1' },
    { seq: 2, start: 20, duration: 10, url: 'v2', discontinuity: true },
    { seq: 3, start: 30, duration: 10, url: 'v3' },
  ],
};
const audio: Rendition = {
  id: 'a',
  bitrate: 128_000,
  codecs: 'mp4a.40.2',
  mimeType: 'audio/mp4',
  segments: [
    { seq: 0, start: 0, duration: 5, url: 'a0' },
    { seq: 1, start: 5, duration: 5, url: 'a1' },
    { seq: 2, start: 10, duration: 5, url: 'a2' },
    { seq: 3, start: 15, duration: 5.02, url: 'a3' },
    { seq: 4, start: 20.02, duration: 5, url: 'a4', discontinuity: true },
    { seq: 5, start: 25.02, duration: 5, url: 'a5' },
  ],
};
const period: Period = {
  id: 'p',
  start: 0,
  tracks: [
    {
      id: 'tv',
      contentType: 'video',
      mimeType: 'video/mp4',
      protection: null,
      renditions: [video],
    },
    {
      id: 'ta',
      contentType: 'audio',
      mimeType: 'audio/mp4',
      protection: null,
      renditions: [audio],
    },
  ],
};

function tracks(options: { videoInflight?: boolean; audioOnly?: boolean } = {}) {
  const v = {
    trackId: 'tv',
    period,
    rendition: video,
    ranges: [],
    sbId: 'sb:video',
    inflight:
      options.videoInflight === true ? [{ token: 'x', trackId: 'tv', seq: 0, url: 'v0' }] : [],
  };
  const a = { trackId: 'ta', period, rendition: audio, ranges: [], sbId: 'sb:audio', inflight: [] };
  return options.audioOnly === true ? [a] : [v, a];
}

const base = { bufferGoal: 30, tokenSeq: 0, leadSbId: 'sb:video' };

describe('scheduler: epoch names and the lead-first hold', () => {
  it('names the opening epoch by period and a discontinuity by its rounded start, across tracks', () => {
    const opening = schedule({ ...base, currentTime: 0, tracks: tracks() });
    expect(opening.requests.map((r) => [r.trackId, r.seq, r.epoch])).toEqual([
      ['tv', 0, 'p'],
      ['ta', 0, 'p'],
    ]);
    const later = schedule({ ...base, currentTime: 22, tracks: tracks() });
    expect(later.requests.map((r) => [r.trackId, r.seq, r.epoch, r.timestampOffset])).toEqual([
      ['tv', 2, 'p:20', 20],
      ['ta', 4, 'p:20', 20.02],
    ]);
  });

  it('without a time probe every track fetches at once, as before', () => {
    const result = schedule({ ...base, currentTime: 0, tracks: tracks(), reconciles: false });
    expect(result.requests.map((r) => r.trackId)).toEqual(['tv', 'ta']);
  });

  it('holds the companion while the lead has a request pending in an unsettled epoch', () => {
    const together = schedule({ ...base, currentTime: 0, tracks: tracks(), reconciles: true });
    // The lead's own request is issued in this pass; audio waits for it.
    expect(together.requests.map((r) => r.trackId)).toEqual(['tv']);

    const inflight = schedule({
      ...base,
      currentTime: 0,
      tracks: tracks({ videoInflight: true }),
      reconciles: true,
      leadPending: true,
    });
    expect(inflight.requests).toEqual([]);
  });

  it('releases the companion once the epoch is settled, or when the lead has nothing pending', () => {
    const settled = schedule({
      ...base,
      currentTime: 0,
      tracks: tracks({ videoInflight: true }),
      reconciles: true,
      leadPending: true,
      reconciled: new Map([['p', -9.958]]),
    });
    expect(settled.requests.map((r) => r.trackId)).toEqual(['ta']);

    // The lead is buffered through here and fetches nothing: audio goes
    // ahead and settles the epoch from its own bytes.
    const idle = schedule({
      ...base,
      currentTime: 0,
      tracks: tracks({ audioOnly: true }),
      reconciles: true,
      leadPending: false,
    });
    expect(idle.requests.map((r) => r.trackId)).toEqual(['ta']);
  });

  it('a discontinuity opens a new epoch the companion waits for again', () => {
    const result = schedule({
      ...base,
      currentTime: 22,
      tracks: tracks(),
      reconciles: true,
      reconciled: new Map([['p', -9.958]]),
    });
    expect(result.requests.map((r) => [r.trackId, r.epoch])).toEqual([['tv', 'p:20']]);
  });
});
