// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { dryRun } from '../../../src/kernel/dry-run.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { createTransport } from '../../../src/kernel/transport.js';
import dashCmaf from '../../../src/protocols/dash-cmaf/index.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import type { SliceReducer } from '../../../src/types/kernel.js';
import type { Fact } from '../../../src/types/messages.js';
import type { Stage, StageContext } from '../../../src/types/stage.js';

const BASE = 'https://cdn.example/reel';

const HLS: Record<string, string> = {
  [`${BASE}/master.m3u8`]: `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="fr",LANGUAGE="fr",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=304x540,AUDIO="aud"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=406x720,AUDIO="aud"
high.m3u8
`,
};
for (const name of ['low', 'high', 'a']) {
  HLS[`${BASE}/${name}.m3u8`] = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="${name}-init.mp4"
#EXTINF:4.0,
${name}-0.m4s
#EXTINF:4.0,
${name}-1.m4s
#EXTINF:4.0,
${name}-2.m4s
#EXT-X-ENDLIST
`;
}

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.42c01e">
      <SegmentTemplate timescale="1" duration="4" initialization="v-$RepresentationID$-init.mp4" media="v-$RepresentationID$-$Number$.m4s" startNumber="1"/>
      <Representation id="low" bandwidth="600000" width="304" height="540"/>
      <Representation id="high" bandwidth="3000000" width="406" height="720"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="fr">
      <SegmentTemplate timescale="1" duration="4" initialization="a-init.mp4" media="a-$Number$.m4s" startNumber="1"/>
      <Representation id="a" bandwidth="96000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

/**
 * What the stages register with the reducer. Every other context method
 * does nothing here: a dry run uses the slices alone.
 */
function slicesOf(...stages: Stage[]): Array<readonly [string, SliceReducer]> {
  const slices: Array<readonly [string, SliceReducer]> = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'reduce'
          ? (name: string, reducer: SliceReducer) => slices.push([name, reducer])
          : key === 'element'
            ? { addEventListener: () => undefined, removeEventListener: () => undefined }
            : () => () => undefined,
    },
  ) as unknown as StageContext;
  for (const stage of stages) stage.install(ctx);
  return slices;
}

/** A transport over a stub network that records each request with its range. */
function network(bodies: Readonly<Record<string, string>>) {
  const requested: string[] = [];
  const facts: Fact[] = [];
  const transport = createTransport({
    absorb: (fact) => facts.push(fact),
    inflight: () => undefined,
    retry: { maxAttempts: 1 },
    fetchImpl: (url) => {
      requested.push(url.slice(BASE.length + 1));
      const body = bodies[url];
      // Anything that is not a manifest is media: a kilobyte of it.
      const media = url.endsWith('.mp4') || url.endsWith('.m4s');
      return Promise.resolve(
        body !== undefined
          ? new Response(body, { status: 200 })
          : media
            ? new Response(new ArrayBuffer(1024), { status: 200 })
            : new Response(null, { status: 404 }),
      );
    },
  });
  return { transport, requested, facts };
}

function run(
  net: ReturnType<typeof network>,
  stages: Stage[],
  url: string,
  segments: number,
): Promise<void> {
  return dryRun(
    {
      slices: slicesOf(...stages),
      config: {},
      hooks: { manifestTypes: new Set(), decodable: () => true },
      transport: net.transport,
      element: {} as HTMLMediaElement,
      seed: { throughputEwma: 0, throughputFastEwma: 0, constraints: [] },
    },
    url,
    { segments, keepMs: 30_000 },
  );
}

describe('a dry run of an HLS load', () => {
  it('requests the manifest, the playlists, the init segments and one media segment per track', async () => {
    const net = network(HLS);
    await run(net, [hlsCmaf()], `${BASE}/master.m3u8`, 1);

    const media = net.requested.filter((name) => !name.endsWith('.m3u8'));
    expect(net.requested[0]).toBe('master.m3u8');
    expect(net.requested.filter((name) => name.endsWith('.m3u8')).sort()).toEqual(
      expect.arrayContaining(['a.m3u8', 'master.m3u8']),
    );
    const video = media.find((name) => name.endsWith('-0.m4s') && !name.startsWith('a-'));
    const rendition = (video as string).split('-')[0];
    expect(media.sort()).toEqual(
      ['a-0.m4s', 'a-init.mp4', `${rendition}-0.m4s`, `${rendition}-init.mp4`].sort(),
    );
  });

  it('requests as many media segments per track as asked', async () => {
    const net = network(HLS);
    await run(net, [hlsCmaf()], `${BASE}/master.m3u8`, 2);

    const segments = net.requested.filter((name) => name.endsWith('.m4s'));
    expect(segments.filter((name) => name.startsWith('a-')).sort()).toEqual(['a-0.m4s', 'a-1.m4s']);
    expect(segments.filter((name) => !name.startsWith('a-'))).toHaveLength(2);
  });

  it('ends when a clip has fewer segments than asked', async () => {
    const net = network(HLS);
    await run(net, [hlsCmaf()], `${BASE}/master.m3u8`, 9);

    expect(net.requested.filter((name) => name.startsWith('a-') && name.endsWith('.m4s'))).toEqual([
      'a-0.m4s',
      'a-1.m4s',
      'a-2.m4s',
    ]);
  });

  it('keeps every response, so the load that follows asks the network for nothing', async () => {
    const net = network(HLS);
    await run(net, [hlsCmaf()], `${BASE}/master.m3u8`, 1);
    const before = net.requested.length;
    const kept = [...net.requested];

    const runner = createEffectRunner();
    net.transport.registerHandlers(runner);
    runner.run(
      kept.map((name, index) => ({
        kind: 'fetch' as const,
        token: `t${index}`,
        url: `${BASE}/${name}`,
      })),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(net.requested).toHaveLength(before);
    expect(net.facts.filter((fact) => fact.type === 'SEGMENT_LOADED')).toHaveLength(kept.length);
  });

  it('rejects when the manifest fails', async () => {
    const net = network({});
    await expect(run(net, [hlsCmaf()], `${BASE}/master.m3u8`, 1)).rejects.toBeDefined();
    expect(net.requested).toEqual(['master.m3u8']);
  });
});

describe('a dry run of a DASH load', () => {
  it('requests the manifest, the init segments and one media segment per track', async () => {
    const net = network({ [`${BASE}/manifest.mpd`]: MPD });
    await run(net, [dashCmaf()], `${BASE}/manifest.mpd`, 1);

    expect(net.requested[0]).toBe('manifest.mpd');
    const media = net.requested.slice(1).sort();
    const rendition = media.some((name) => name.startsWith('v-high')) ? 'high' : 'low';
    expect(media).toEqual(
      ['a-1.m4s', 'a-init.mp4', `v-${rendition}-1.m4s`, `v-${rendition}-init.mp4`].sort(),
    );
  });

  it('runs beside an HLS adapter in the same composition', async () => {
    const net = network({ [`${BASE}/manifest.mpd`]: MPD });
    await run(net, [hlsCmaf(), dashCmaf()], `${BASE}/manifest.mpd`, 1);

    expect(net.requested.filter((name) => name.endsWith('.m4s')).sort()).toHaveLength(2);
  });
});

describe('a load with a seed', () => {
  it('starts from the estimate and the constraints of the preload', () => {
    const reduce = createReducer([], {});
    const [attached] = reduce(initialState({}), {
      type: 'ATTACH',
      element: {} as HTMLMediaElement,
    });
    const [loading] = reduce(attached, {
      type: 'LOAD',
      url: `${BASE}/master.m3u8`,
      seed: {
        throughputEwma: 4_000_000,
        throughputFastEwma: 3_000_000,
        constraints: [['element-size', { maxHeight: 540 }]],
      },
    });

    expect(loading.stats).toMatchObject({
      throughputEwma: 4_000_000,
      throughputFastEwma: 3_000_000,
    });
    expect([...loading.quality.constraints]).toEqual([['element-size', { maxHeight: 540 }]]);
  });

  it('keeps the throughput estimate across a detach, as across an unload', () => {
    const reduce = createReducer([], {});
    const [attached] = reduce(initialState({}), {
      type: 'ATTACH',
      element: {} as HTMLMediaElement,
    });
    const measured = {
      ...attached,
      stats: { throughputEwma: 5_000_000, throughputFastEwma: 4_000_000 },
    };
    const [detached] = reduce(measured, { type: 'DETACH' });

    expect(detached.lifecycle.phase).toBe('idle');
    expect(detached.stats).toEqual({ throughputEwma: 5_000_000, throughputFastEwma: 4_000_000 });
  });
});
