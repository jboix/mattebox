import { describe, expect, it } from 'vitest';
import type {
  Effect,
  InflightRequest,
  Period,
  Rendition,
  TimeRangesSnapshot,
} from '../../../src/index.js';
import { createReducer } from '../../../src/kernel/reducer.js';
import type { ScheduleInput, ScheduleTrackInput } from '../../../src/kernel/scheduler.js';
import { bufferedEndFrom, schedule } from '../../../src/kernel/scheduler.js';
import { createMseSink } from '../../../src/kernel/sinks/mse-sink.js';
import { createNullSink } from '../../helpers/null-sink.js';
import { deepFreeze, readyStateWithInflight } from './helpers.js';

const reduce = createReducer();

function vodRendition(count: number, duration = 4): Rendition {
  const segments = Array.from({ length: count }, (_, seq) => ({
    seq,
    start: seq * duration,
    duration,
    url: `https://cdn.example/v/${seq}.m4s`,
  }));
  return { id: 'v-1', bitrate: 1_000_000, codecs: 'avc1', mimeType: 'video/mp4', segments };
}

function vodPeriod(rendition: Rendition): Period {
  return {
    id: 'p0',
    start: 0,
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

function track(overrides: Partial<ScheduleTrackInput> = {}): ScheduleTrackInput {
  const rendition = vodRendition(100);
  return {
    trackId: 'v',
    period: vodPeriod(rendition),
    rendition,
    ranges: [],
    sbId: 'sb:video',
    inflight: [],
    ...overrides,
  };
}

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return { currentTime: 0, bufferGoal: 30, tokenSeq: 0, tracks: [track()], ...overrides };
}

describe('a segment whose media ran short of its playlist duration', () => {
  it('is not fetched again once the buffered run passes its midpoint; the next one is', () => {
    // Segment 2 (8-12 s) was appended but its media ends at 11.7 s.
    const result = schedule(input({ tracks: [track({ ranges: [{ start: 0, end: 11.7 }] })] }));
    expect(result.requests.map((r) => r.seq)).toEqual([3]);
  });

  it('is fetched when the run ends before its midpoint, which reads as not yet appended', () => {
    const result = schedule(input({ tracks: [track({ ranges: [{ start: 0, end: 8.9 }] })] }));
    expect(result.requests.map((r) => r.seq)).toEqual([2]);
  });

  it('walks past segments buffered beyond the hole, so a hole wider than the tolerance never loops', () => {
    // Segments 3 and 4 (12-20 s) already sit beyond the 11.7-12 hole.
    const result = schedule(
      input({
        tracks: [
          track({
            ranges: [
              { start: 0, end: 11.7 },
              { start: 12, end: 20 },
            ],
          }),
        ],
      }),
    );
    expect(result.requests.map((r) => r.seq)).toEqual([5]);
  });

  it('stops walking once what lies beyond the hole already meets the buffer goal', () => {
    const result = schedule(
      input({
        tracks: [
          track({
            ranges: [
              { start: 0, end: 11.7 },
              { start: 12, end: 40 },
            ],
          }),
        ],
      }),
    );
    expect(result.requests).toEqual([]);
  });

  it('as the last segment yields no fetch instead of a loop', () => {
    const rendition = vodRendition(3);
    const result = schedule(
      input({
        tracks: [
          track({ rendition, period: vodPeriod(rendition), ranges: [{ start: 0, end: 11.7 }] }),
        ],
      }),
    );
    expect(result.requests).toEqual([]);
  });
});

describe('a segment whose first keyframe sits past its midpoint', () => {
  // The packager cut segments off the GOP grid: segment 0 (0-4 s) carries
  // its first sync sample at 2.88 s, so MSE drops the frames before it and
  // the append shows up as 2.88-4. Real case: an RTS VOD asset with
  // keyframes at 1.44 s + 2k on a 2 s segmentation.
  it('counts as appended once its tail is buffered; the next one is fetched', () => {
    const result = schedule(input({ tracks: [track({ ranges: [{ start: 2.88, end: 4 }] })] }));
    expect(result.requests.map((r) => r.seq)).toEqual([1]);
  });

  it('walks past the following segments that appended continuously', () => {
    const result = schedule(input({ tracks: [track({ ranges: [{ start: 2.88, end: 12 }] })] }));
    expect(result.requests.map((r) => r.seq)).toEqual([3]);
  });

  it('a sliver shorter than the tolerance at the tail still reads as not appended', () => {
    const result = schedule(input({ tracks: [track({ ranges: [{ start: 3.9, end: 4 }] })] }));
    expect(result.requests.map((r) => r.seq)).toEqual([0]);
  });
});

describe('buffer goal', () => {
  it('emits nothing when the goal is reached', () => {
    const result = schedule(input({ tracks: [track({ ranges: [{ start: 0, end: 32 }] })] }));
    expect(result.effects).toEqual([]);
    expect(result.requests).toEqual([]);
  });

  it('emits exactly one fetch per track below goal, never a burst', () => {
    const audio = vodRendition(100, 2);
    const result = schedule(
      input({
        tracks: [
          track({ ranges: [{ start: 0, end: 8 }] }),
          track({
            trackId: 'a',
            rendition: audio,
            period: vodPeriod(audio),
            ranges: [],
            sbId: 'sb:audio',
          }),
        ],
      }),
    );
    expect(result.effects.filter((e) => e.kind === 'fetch')).toHaveLength(2);
    expect(result.requests.map((r) => [r.trackId, r.seq])).toEqual([
      ['v', 2],
      ['a', 0],
    ]);
    // The same input again, with those requests in flight, adds nothing.
    const again = schedule(
      input({
        tokenSeq: result.tokenSeq,
        tracks: [
          track({
            ranges: [{ start: 0, end: 8 }],
            inflight: [result.requests[0] as InflightRequest],
          }),
          track({
            trackId: 'a',
            rendition: audio,
            period: vodPeriod(audio),
            sbId: 'sb:audio',
            inflight: [result.requests[1] as InflightRequest],
          }),
        ],
      }),
    );
    expect(again.effects).toEqual([]);
  });

  it('tolerates coalesced and rounded ranges from the sink', () => {
    // Browsers report 3.98 where 4.0 was appended and merge close ranges.
    const ranges: TimeRangesSnapshot = [
      { start: 0.02, end: 3.98 },
      { start: 4.01, end: 7.99 },
    ];
    expect(bufferedEndFrom(ranges, 0, 0.25)).toBeCloseTo(7.99);
    const result = schedule(input({ tracks: [track({ ranges })] }));
    // Continues from the coalesced end: next is segment 2, not a refetch of 0 or 1.
    expect(result.requests[0]?.seq).toBe(2);
  });
});

describe('seek handling', () => {
  it('seek mid-fetch aborts, then reschedules the correct segment', () => {
    const first = schedule(input());
    expect(first.requests[0]?.seq).toBe(0);

    const state = readyStateWithInflight(first.requests);
    const [afterSeek, fx] = reduce(deepFreeze(structuredClone(state)), { type: 'SEEK', to: 100 });
    expect(fx).toContainEqual({ kind: 'abort', token: first.requests[0]?.token });
    expect(afterSeek.scheduling.inflight.size).toBe(0);

    const resumed = schedule(
      input({ currentTime: 100, tokenSeq: afterSeek.scheduling.tokenSeq, tracks: [track()] }),
    );
    expect(resumed.requests[0]?.seq).toBe(25);
    expect(resumed.effects[0]).toMatchObject({
      kind: 'fetch',
      url: 'https://cdn.example/v/25.m4s',
    });
  });

  it('a late SEGMENT_LOADED after the seek produces no append', () => {
    const first = schedule(input());
    const state = readyStateWithInflight(first.requests);
    const [afterSeek] = reduce(deepFreeze(structuredClone(state)), { type: 'SEEK', to: 100 });
    const [, fx] = reduce(deepFreeze(structuredClone(afterSeek)), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 0,
      bytes: new ArrayBuffer(8),
      rtt: 30,
      size: 8,
    });
    expect(fx.filter((e) => e.kind === 'append')).toHaveLength(0);
  });
});

describe('discontinuities and periods through one path', () => {
  it('a discontinuity crossing applies setTimestampOffset before the append', () => {
    const rendition: Rendition = {
      id: 'v-1',
      bitrate: 1,
      codecs: 'avc1',
      mimeType: 'video/mp4',
      segments: [
        { seq: 0, start: 0, duration: 4, url: 'u0' },
        { seq: 1, start: 4, duration: 4, url: 'u1', discontinuity: true },
      ],
    };
    const result = schedule(
      input({
        tracks: [
          track({ rendition, period: vodPeriod(rendition), ranges: [{ start: 0, end: 4 }] }),
        ],
        bufferGoal: 10,
      }),
    );
    expect(result.requests[0]).toMatchObject({ seq: 1, timestampOffset: 4 });

    const state = readyStateWithInflight(result.requests);
    const bytes = new ArrayBuffer(8);
    const [, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 1,
      bytes,
      rtt: 10,
      size: 8,
    });
    expect(fx.slice(0, 2)).toMatchObject([
      { kind: 'setTimestampOffset', sbId: 'sb:video', offset: 4 },
      { kind: 'append', sbId: 'sb:video', data: bytes, start: 4 },
    ]);
  });

  it('a period boundary produces the identical effect sequence', () => {
    const r2: Rendition = {
      id: 'v-1',
      bitrate: 1,
      codecs: 'avc1',
      mimeType: 'video/mp4',
      segments: [{ seq: 1, start: 4, duration: 4, url: 'u1' }],
    };
    const p2: Period = { ...vodPeriod(r2), id: 'p1', start: 4 };
    const result = schedule(
      input({
        tracks: [track({ rendition: r2, period: p2, ranges: [{ start: 0, end: 4 }] })],
        bufferGoal: 10,
      }),
    );
    expect(result.requests[0]).toMatchObject({ seq: 1, timestampOffset: 4 });

    const state = readyStateWithInflight(result.requests);
    const bytes = new ArrayBuffer(8);
    const [, fx] = reduce(deepFreeze(structuredClone(state)), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 1,
      bytes,
      rtt: 10,
      size: 8,
    });
    // Byte-identical to the discontinuity case: one code path.
    expect(fx.slice(0, 2)).toMatchObject([
      { kind: 'setTimestampOffset', sbId: 'sb:video', offset: 4 },
      { kind: 'append', sbId: 'sb:video', data: bytes, start: 4 },
    ]);
  });
});

describe('live window', () => {
  it('segments fallen out of the sliding window are not fetched', () => {
    const rendition = vodRendition(100);
    const result = schedule(
      input({
        currentTime: 10,
        tracks: [track({ rendition, ranges: [] })],
        liveWindow: { start: 40, end: 80 },
      }),
    );
    // Position 10 slid out; scheduling resumes at the window start.
    expect(result.requests[0]?.seq).toBe(10);
    expect((result.requests[0]?.seq ?? 0) * 4).toBeGreaterThanOrEqual(40);
  });

  it('segments beyond the edge are not fetched', () => {
    const rendition = vodRendition(100);
    const result = schedule(
      input({
        currentTime: 76,
        tracks: [track({ rendition, ranges: [{ start: 70, end: 80 }] })],
        liveWindow: { start: 40, end: 81 },
      }),
    );
    // Next would be seq 20 ([80, 84]), which ends past the edge at 81.
    expect(result.effects).toEqual([]);
  });
});

describe('the sink abstraction is real', () => {
  it('drives NullSink and MseSink with identical effect sequences', () => {
    const meta = (seq: number) => ({
      trackId: 'v',
      renditionId: 'v-1',
      contentType: 'video' as const,
      seq,
      start: seq * 4,
      duration: 4,
      isInit: false,
    });

    // Drive a schedule/arrive loop where the only buffer knowledge comes
    // from the Sink interface. Both sinks must produce the same decisions
    // and the same effects, or the scheduler is leaking assumptions.
    function drive(
      ranges: (trackId: string) => TimeRangesSnapshot,
      arrive: (seq: number) => readonly Effect[],
    ) {
      const emitted: Effect[] = [];
      let tokenSeq = 0;
      for (let step = 0; step < 6; step += 1) {
        const result = schedule({
          currentTime: 0,
          bufferGoal: 12,
          tokenSeq,
          tracks: [track({ ranges: ranges('v'), inflight: [] })],
        });
        emitted.push(...result.effects);
        tokenSeq = result.tokenSeq;
        for (const request of result.requests) {
          emitted.push(...arrive(request.seq));
        }
      }
      return emitted;
    }

    const nullSink = createNullSink('video', 'sb:video');
    const nullEffects = drive(
      (trackId) => nullSink.ranges(trackId),
      (seq) => {
        const fx = nullSink.accept('v', new ArrayBuffer(4), meta(seq));
        nullSink.settle();
        return fx;
      },
    );

    let mseLedger: TimeRangesSnapshot = [];
    const mseSink = createMseSink('video', { buffered: () => mseLedger });
    const mseEffects = drive(
      (trackId) => mseSink.ranges(trackId),
      (seq) => {
        const fx = mseSink.accept('v', new ArrayBuffer(4), meta(seq));
        // What the browser would report after the append lands.
        mseLedger = [{ start: 0, end: (seq + 1) * 4 }];
        return fx;
      },
    );

    expect(mseEffects).toEqual(nullEffects);
    expect(nullEffects.filter((e) => e.kind === 'fetch')).toHaveLength(3);
    expect(nullEffects.filter((e) => e.kind === 'append')).toHaveLength(3);
  });

  it('NullSink and MseSink return the same effect shapes for accept and clear', () => {
    const nullSink = createNullSink('video', 'sb:video');
    const mseSink = createMseSink('video', { buffered: () => [] });
    const bytes = new ArrayBuffer(4);
    const meta = {
      trackId: 'v',
      renditionId: 'v-1',
      contentType: 'video' as const,
      seq: 0,
      start: 0,
      duration: 4,
      isInit: false,
    };
    expect(nullSink.accept('v', bytes, meta)).toEqual(mseSink.accept('v', bytes, meta));
    expect(nullSink.clear('v', 0, 2)).toEqual(mseSink.clear('v', 0, 2));
  });
});
