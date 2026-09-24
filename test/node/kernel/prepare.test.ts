import { describe, expect, it } from 'vitest';
import { createSegmentPreparer } from '../../../src/kernel/prepare.js';
import type { InflightRequest } from '../../../src/types/kernel.js';
import type { Fact, SegmentMeta } from '../../../src/types/messages.js';
import type { MediaTimeProbe, TransformStep } from '../../../src/types/stage.js';

const requests = new Map<string, InflightRequest>([
  [
    'v0',
    {
      token: 'v0',
      trackId: 'v',
      seq: 0,
      url: 'v/0.m4s',
      sbId: 'sb:video',
      renditionId: 'v-1',
      segmentStart: 12,
      segmentDuration: 4,
    },
  ],
  [
    'v1',
    { token: 'v1', trackId: 'v', seq: 1, url: 'v/1.m4s', sbId: 'sb:video', renditionId: 'v-1' },
  ],
  [
    'vi',
    { token: 'vi', trackId: 'v', seq: -1, url: 'v/init.mp4', sbId: 'sb:video', renditionId: 'v-1' },
  ],
  [
    'a0',
    { token: 'a0', trackId: 'a', seq: 0, url: 'a/0.m4s', sbId: 'sb:audio', renditionId: 'a-1' },
  ],
  ['t0', { token: 't0', trackId: 't', seq: 0, url: 't/0.vtt' }],
]);

function loaded(token: string, bytes: number[] = [1, 2, 3]): Fact {
  const request = requests.get(token) as InflightRequest;
  return {
    type: 'SEGMENT_LOADED',
    trackId: request.trackId,
    seq: request.seq,
    token,
    bytes: new Uint8Array(bytes).buffer,
    rtt: 10,
    size: bytes.length,
  };
}

function harness(steps: TransformStep[] = [], probe: MediaTimeProbe | null = null) {
  const facts: Fact[] = [];
  const prepare = createSegmentPreparer({
    transforms: () => steps,
    timeProbe: () => probe,
    inflight: (token) => requests.get(token),
    absorb: (fact) => facts.push(fact),
  });
  return { prepare, facts };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the segment preparer', () => {
  it('forwards everything but media segments untouched and synchronously', () => {
    const { prepare, facts } = harness([
      { name: 'x', order: 1, transform: () => new Uint8Array(0) },
    ]);
    const manifest: Fact = {
      type: 'MANIFEST_FAILED',
      error: {
        category: 'manifest',
        code: 'MANIFEST_UNSUPPORTED',
        fatal: true,
        recoverable: false,
      },
    };
    const cue = loaded('t0');
    prepare(manifest);
    prepare(cue);
    expect(facts).toEqual([manifest, cue]);
  });

  it('forwards a media segment as it came when nothing is registered', () => {
    const { prepare, facts } = harness();
    const fact = loaded('v0');
    prepare(fact);
    expect(facts).toEqual([fact]);
  });

  it('runs the transforms in pipeline order with the segment meta, then probes the result', async () => {
    const seen: Array<[string, SegmentMeta]> = [];
    const unordered: TransformStep[] = [
      {
        name: 'second',
        order: 100,
        transform: async (data, meta) => {
          seen.push(['second', meta]);
          return new Uint8Array([...data, 20]);
        },
      },
      {
        name: 'first',
        order: 1,
        transform: (data, meta) => {
          seen.push(['first', meta]);
          return new Uint8Array([...data, 10]);
        },
      },
    ];
    const steps = unordered.sort((a, b) => a.order - b.order);
    const probed: Uint8Array[] = [];
    const probe: MediaTimeProbe = (bytes) => {
      probed.push(bytes);
      return 9.958;
    };
    const { prepare, facts } = harness(steps, probe);
    prepare(loaded('v0'));
    expect(facts).toEqual([]);
    await flush();
    expect(seen.map(([name]) => name)).toEqual(['first', 'second']);
    expect(seen[0]?.[1]).toEqual({
      trackId: 'v',
      renditionId: 'v-1',
      contentType: 'video',
      seq: 0,
      start: 12,
      duration: 4,
      isInit: false,
    });
    expect([...(probed[0] as Uint8Array)]).toEqual([1, 2, 3, 10, 20]);
    expect(facts[0]).toMatchObject({
      type: 'SEGMENT_LOADED',
      token: 'v0',
      size: 3,
      mediaStart: 9.958,
    });
    expect([...new Uint8Array((facts[0] as { bytes: ArrayBuffer }).bytes)]).toEqual([
      1, 2, 3, 10, 20,
    ]);
  });

  it('hands the probe an init segment but attaches no decode time to it', async () => {
    const metas: SegmentMeta[] = [];
    const { prepare, facts } = harness([], (_bytes, meta) => {
      metas.push(meta);
      return 5;
    });
    prepare(loaded('vi'));
    prepare(loaded('a0'));
    await flush();
    expect(metas.map((m) => [m.contentType, m.isInit])).toEqual([
      ['video', true],
      ['audio', false],
    ]);
    expect('mediaStart' in (facts[0] as object)).toBe(false);
    expect(facts[1]).toMatchObject({ token: 'a0', mediaStart: 5 });
  });

  it('a probe that reads nothing, or throws, leaves the fact without a decode time', async () => {
    const { prepare, facts } = harness([], () => null);
    prepare(loaded('v0'));
    const thrower = harness([], () => {
      throw new Error('bad box');
    });
    thrower.prepare(loaded('v0'));
    await flush();
    expect('mediaStart' in (facts[0] as object)).toBe(false);
    expect(thrower.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', token: 'v0' });
  });

  it('keeps one buffer in arrival order even when an earlier transform is slower', async () => {
    const step: TransformStep = {
      name: 'slow-first',
      order: 1,
      transform: async (data, meta) => {
        await new Promise((resolve) => setTimeout(resolve, meta.seq === 0 ? 20 : 0));
        return data;
      },
    };
    const { prepare, facts } = harness([step]);
    prepare(loaded('v0'));
    prepare(loaded('v1'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(facts.map((f) => (f as { token: string }).token)).toEqual(['v0', 'v1']);
  });

  it('reports a failing transform as a container failure of that segment', async () => {
    const step: TransformStep = {
      name: 'broken',
      order: 1,
      transform: () => {
        throw new Error('not a transport stream');
      },
    };
    const { prepare, facts } = harness([step]);
    prepare(loaded('v0'));
    await flush();
    expect(facts[0]).toMatchObject({
      type: 'SEGMENT_FAILED',
      trackId: 'v',
      seq: 0,
      renditionId: 'v-1',
      error: { category: 'media', code: 'MEDIA_CONTAINER_INVALID', fatal: false },
    });
  });
});
