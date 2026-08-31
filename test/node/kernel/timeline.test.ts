import { describe, expect, it } from 'vitest';
import type { Period, Rendition } from '../../../src/index.js';
import {
  buildEpochs,
  epochForSeq,
  mediaToPresentation,
  presentationToMedia,
  reconcileTfdt,
  seekableWindow,
  segmentAt,
  segmentAtTime,
  timestampOffsetFor,
} from '../../../src/kernel/timeline.js';

function listRendition(segments: Rendition['segments']): Rendition {
  return { id: 'v-1', bitrate: 1, codecs: 'avc1', mimeType: 'video/mp4', segments };
}

function period(id: string, start: number, rendition: Rendition): Period {
  return {
    id,
    start,
    tracks: [
      {
        id: 'v',
        contentType: 'video',
        mimeType: 'video/mp4',
        protection: null,
        renditions: [rendition],
      },
    ],
  };
}

describe('one code path for discontinuities and period boundaries', () => {
  it('an HLS discontinuity opens a new epoch mid-list', () => {
    const rendition = listRendition([
      { seq: 0, start: 0, duration: 4, url: 'u0' },
      { seq: 1, start: 4, duration: 4, url: 'u1' },
      { seq: 2, start: 8, duration: 4, url: 'u2', discontinuity: true },
      { seq: 3, start: 12, duration: 4, url: 'u3' },
    ]);
    const epochs = buildEpochs([{ period: period('p0', 0, rendition), rendition }]);
    expect(epochs).toHaveLength(2);
    expect(timestampOffsetFor(epochs[0] as never)).toBe(0);
    expect(timestampOffsetFor(epochs[1] as never)).toBe(8);
    expect(epochForSeq(epochs, 1)?.presentationStart).toBe(0);
    expect(epochForSeq(epochs, 3)?.presentationStart).toBe(8);
  });

  it('a DASH period boundary produces the same epoch shape through the same function', () => {
    const r1 = listRendition([{ seq: 0, start: 0, duration: 4, url: 'a0' }]);
    const r2 = listRendition([{ seq: 10, start: 4, duration: 4, url: 'b0' }]);
    const epochs = buildEpochs([
      { period: period('p0', 0, r1), rendition: r1 },
      { period: period('p1', 4, r2), rendition: r2 },
    ]);
    expect(epochs).toHaveLength(2);
    // The exact structure a discontinuity yields: only the ids differ.
    expect(epochs[1]).toEqual({
      periodId: 'p1',
      firstSeq: 10,
      presentationStart: 4,
      mediaStart: 0,
    });
    expect(timestampOffsetFor(epochs[1] as never)).toBe(4);
  });

  it('an indexed rendition maps presentationTimeOffset into the epoch', () => {
    const rendition = listRendition({
      kind: 'indexed',
      urlTemplate: 'seg-$Number$.m4s',
      startSeq: 100,
      endSeq: null,
      timescale: 1000,
      segmentDuration: 4000,
      timeline: null,
      presentationTimeOffset: 2000,
    });
    const epochs = buildEpochs([{ period: period('p0', 10, rendition), rendition }]);
    expect(epochs[0]).toEqual({
      periodId: 'p0',
      firstSeq: 100,
      presentationStart: 10,
      mediaStart: 2,
    });
    expect(timestampOffsetFor(epochs[0] as never)).toBe(8);
  });
});

describe('media and presentation time mapping', () => {
  const epoch = { periodId: 'p0', firstSeq: 0, presentationStart: 10, mediaStart: 2 };

  it('round-trips', () => {
    expect(mediaToPresentation(2, epoch)).toBe(10);
    expect(presentationToMedia(10, epoch)).toBe(2);
    expect(presentationToMedia(mediaToPresentation(7.5, epoch), epoch)).toBe(7.5);
  });

  it('reconcileTfdt corrects the media start from a real baseMediaDecodeTime', () => {
    const corrected = reconcileTfdt(epoch, 90_000, 30_000);
    expect(corrected.mediaStart).toBe(3);
    expect(timestampOffsetFor(corrected)).toBe(7);
  });
});

describe('segment addressing', () => {
  it('expands $Number$ and $Time$ templates without materializing arrays', () => {
    const constant = listRendition({
      kind: 'indexed',
      urlTemplate: 'v/$Number$.m4s',
      startSeq: 5,
      endSeq: null,
      timescale: 1000,
      segmentDuration: 2000,
      timeline: null,
    }).segments;
    expect(segmentAt(constant, 7, 100)).toEqual({
      seq: 7,
      start: 104,
      duration: 2,
      url: 'v/7.m4s',
    });
    expect(segmentAt(constant, 4)).toBeNull();

    const timeline = listRendition({
      kind: 'indexed',
      urlTemplate: 'v/$Time$.m4s',
      startSeq: 0,
      endSeq: 5,
      timescale: 1000,
      segmentDuration: null,
      timeline: [
        { start: 0, duration: 2000, count: 3 },
        { start: 6000, duration: 1000, count: 3 },
      ],
    }).segments;
    expect(segmentAt(timeline, 4)).toEqual({ seq: 4, start: 7, duration: 1, url: 'v/7000.m4s' });
    expect(segmentAt(timeline, 6)).toBeNull();
  });

  it('finds the segment containing a time in lists and templates', () => {
    const list = listRendition([
      { seq: 0, start: 0, duration: 4, url: 'u0' },
      { seq: 1, start: 4, duration: 4, url: 'u1' },
    ]).segments;
    expect(segmentAtTime(list, 5)?.seq).toBe(1);
    expect(segmentAtTime(list, 9)).toBeNull();

    const constant = listRendition({
      kind: 'indexed',
      urlTemplate: 'v/$Number$.m4s',
      startSeq: 0,
      endSeq: 9,
      timescale: 1,
      segmentDuration: 2,
      timeline: null,
    }).segments;
    expect(segmentAtTime(constant, 5)?.seq).toBe(2);
    expect(segmentAtTime(constant, 21)).toBeNull();
  });
});

describe('seekable window', () => {
  it('VOD spans zero to the duration', () => {
    const rendition = listRendition([{ seq: 0, start: 0, duration: 4, url: 'u' }]);
    const presentation = {
      id: 'vod',
      isLive: false,
      duration: 600,
      periods: [period('p0', 0, rendition)],
      couplings: [],
    };
    expect(seekableWindow(presentation, null)).toEqual({ start: 0, end: 600 });
  });

  it('live slides from the earliest available segment to the supplied edge', () => {
    const rendition = listRendition([
      { seq: 40, start: 160, duration: 4, url: 'u40' },
      { seq: 41, start: 164, duration: 4, url: 'u41' },
    ]);
    const presentation = {
      id: 'live',
      isLive: true,
      periods: [period('p0', 0, rendition)],
      couplings: [],
    };
    expect(seekableWindow(presentation, 172)).toEqual({ start: 160, end: 172 });
  });
});
