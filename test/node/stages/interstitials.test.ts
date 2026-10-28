// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { assetsOf, breaksOf } from '../../../src/stages/interstitials/breaks.js';
import interstitials, { type InterstitialsApi } from '../../../src/stages/interstitials/index.js';
import type { DateRange, Presentation, PresentationEvent } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

const MASTER = 'https://cdn.example/master.m3u8';
const MEDIA = 'https://cdn.example/v/low.m3u8';

function presentation(
  ranges: readonly DateRange[],
  events: readonly PresentationEvent[] = [],
  id = 'p1',
): Presentation {
  return {
    id,
    isLive: false,
    duration: 60,
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
              {
                id: 'v0',
                bitrate: 1,
                codecs: null,
                mimeType: 'video/mp4',
                segments: [],
                playlistUrl: MEDIA,
                dateRanges: ranges,
              },
            ],
          },
        ],
        events,
      },
    ],
  };
}

const range = (
  id: string,
  start: number,
  attributes: Record<string, string>,
  end?: number,
): DateRange => ({
  id,
  start,
  ...(end !== undefined ? { end } : {}),
  startDate: 0,
  attributes: { ID: id, ...attributes },
});
const ad = (id: string, start: number, extra: Record<string, string> = {}, end?: number) =>
  range(
    id,
    start,
    { CLASS: 'com.apple.hls.interstitial', 'X-ASSET-URI': `ads/${id}.m3u8`, ...extra },
    end,
  );

describe('breaks from the stream', () => {
  it('maps HLS interstitials: cue, assets against the media playlist, resume, restrictions', () => {
    const breaks = breaksOf(
      presentation([
        ad('pre', 0, { CUE: 'PRE,ONCE' }),
        ad('mid', 20, { 'X-RESTRICT': 'SKIP,JUMP', 'X-TIMELINE-OCCUPIES': 'RANGE' }, 28),
        ad('post', 0, { CUE: 'POST' }),
        range('list', 40, {
          CLASS: 'com.apple.hls.interstitial',
          'X-ASSET-LIST': 'list.json',
          'X-RESUME-OFFSET': '0',
          'X-PLAYOUT-LIMIT': '15',
        }),
      ]),
      MASTER,
    );
    expect(breaks.map((b) => [b.id, b.start, b.cue ?? null, b.once])).toEqual([
      ['pre', 0, 'pre', true],
      ['mid', 20, null, false],
      ['list', 40, null, false],
      ['post', 60, 'post', false],
    ]);
    const mid = breaks.find((b) => b.id === 'mid');
    expect(mid).toMatchObject({
      assets: [{ url: 'https://cdn.example/v/ads/mid.m3u8' }],
      covers: 8,
      resumeOffset: 8,
      noSkip: true,
      noJump: true,
    });
    expect(breaks.find((b) => b.id === 'list')).toMatchObject({
      assets: [],
      assetList: 'https://cdn.example/v/list.json',
      resumeOffset: 0,
      playoutLimit: 15,
    });
  });

  it('a cue-out is a break with no assets: the presentation plays through it', () => {
    const [cue] = breaksOf(presentation([range('cue-out-12', 24, { 'CUE-OUT': '8' }, 32)]), MASTER);
    expect(cue).toMatchObject({ source: 'scte35', start: 24, covers: 8, assets: [] });
  });

  it('maps DASH alternative MPD replace and insert, with the MPD query carried (Annex I)', () => {
    const mpd = 'https://live.example/Manifest.mpd?sessionId=s1&interests=travel';
    const param = {
      name: 'RequestParam',
      attributes: {
        queryTemplate: '$querypart$',
        useMPDUrlQuery: 'true',
        includeInRequests: 'altmpd',
      },
    };
    const breaks = breaksOf(
      presentation(
        [],
        [
          {
            scheme: 'urn:mpeg:dash:event:alternativeMPD:replace:2025',
            id: 'r1',
            start: 30,
            duration: 20,
            timescale: 90000,
            elements: [
              {
                name: 'ReplacePresentation',
                attributes: {
                  uri: 'https://ads.example/ads?break=r1',
                  maxDuration: '1800000',
                  earliestResolutionTimeOffset: '540000',
                  executeOnce: 'true',
                },
              },
            ],
            streamElements: [param],
          },
          {
            scheme: 'urn:mpeg:dash:event:alternativeMPD:insert:2025',
            id: 'i1',
            start: 10,
            timescale: 1,
            elements: [{ name: 'InsertPresentation', attributes: { uri: 'ad.mpd', noJump: '1' } }],
          },
        ],
      ),
      mpd,
    );
    expect(breaks.find((b) => b.id === 'r1')).toMatchObject({
      source: 'dash',
      assetList: 'https://ads.example/ads?break=r1&sessionId=s1&interests=travel',
      covers: 20,
      resumeOffset: 20,
      playoutLimit: 20,
      resolveAhead: 6,
      once: true,
    });
    expect(breaks.find((b) => b.id === 'i1')).toMatchObject({
      assetList: 'https://live.example/ad.mpd',
      covers: 0,
      resumeOffset: 0,
      noJump: true,
    });
  });

  it('gives a SCTE-35 span the role its segmentation type names, and leaves out what is no span', () => {
    // SCTE 35 §14's time_signal sample, a provider placement opportunity
    // (0x34), with its segmentation_type_id rewritten; the decoder reads no CRC.
    const sample = Uint8Array.from(
      atob('/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg=='),
      (c) => c.charCodeAt(0),
    );
    const typed = (type: number) => {
      const bytes = sample.slice();
      bytes[bytes.lastIndexOf(0x34)] = type;
      return {
        CLASS: 'x',
        'SCTE35-OUT': `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
      };
    };
    const breaks = breaksOf(
      presentation([
        range('po', 10, typed(0x34)),
        range('promo', 20, typed(0x3c)),
        range('intro', 30, typed(0x24)),
        range('credits', 40, typed(0x26)),
        range('program-start', 50, typed(0x10)),
        range('overlay', 60, typed(0x38)),
      ]),
      MASTER,
    );
    expect(breaks.map((b) => [b.id, b.role ?? 'ad', b.covers])).toEqual([
      ['po', 'ad', 307],
      ['promo', 'promo', 307],
      ['intro', 'opening-credits', 307],
      ['credits', 'closing-credits', 307],
    ]);
  });

  it('reads a DASH SCTE-35 event, its section in base64', () => {
    // SCTE 35 §14's time_signal sample, a provider placement opportunity.
    const event: PresentationEvent = {
      scheme: 'urn:scte:scte35:2013:bin',
      id: '7',
      start: 12,
      data: '/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg==',
    } as PresentationEvent;
    const [found] = breaksOf(presentation([], [event]), MASTER);
    expect(found).toMatchObject({ start: 12, covers: 307, assets: [] });
    expect(found?.role).toBeUndefined();
    // A section that does not decode is no span.
    expect(breaksOf(presentation([], [{ ...event, data: '%%' }]), MASTER)).toEqual([]);
  });

  it('reads SVTA2053 creatives as a span the stream plays, with their typed beacons', () => {
    // As DASH-IF livesim2 writes it (svta_p60:20;skip=5;click=1).
    const payload = JSON.stringify({
      version: 2,
      type: 'slot',
      payload: [
        {
          type: 'linear',
          start: 0,
          duration: 10,
          identifiers: [
            { scheme: 'urn:smpte:ul:060E2B34.01040101.01200900.00000000', value: 'LSIM1' },
          ],
          tracking: [
            { type: 'impression', urls: ['https://b.example/impression'] },
            { type: 'firstQuartile', urls: ['https://b.example/q1'] },
          ],
          skipOffset: 5,
          clickThrough: 'https://brand.example/',
        },
      ],
    });
    const [entry] = breaksOf(
      presentation(
        [],
        [
          {
            scheme: 'urn:svta:advertising-wg:ad-creative-signaling',
            id: '42',
            start: 60,
            duration: 10,
            timescale: 90000,
            data: payload,
          },
        ],
      ),
      MASTER,
    );
    expect(entry).toMatchObject({ source: 'dash', start: 60, covers: 10, assets: [] });
    expect(entry?.creatives).toEqual([
      {
        duration: 10,
        identifiers: [
          { scheme: 'urn:smpte:ul:060E2B34.01040101.01200900.00000000', value: 'LSIM1' },
        ],
        tracking: [
          { event: 'impression', url: 'https://b.example/impression' },
          { event: 'firstQuartile', url: 'https://b.example/q1' },
        ],
        skipOffset: 5,
        clickThrough: 'https://brand.example/',
      },
    ]);
    // HLS carries the same payload, base64, on a date range.
    const [hls] = breaksOf(
      presentation([range('svta', 30, { 'X-AD-CREATIVE-SIGNALING': btoa(payload) }, 40)]),
      MASTER,
    );
    expect(hls?.creatives?.[0]?.skipOffset).toBe(5);
  });

  it('reads an HLS asset list and a DASH List MPD, with its callback beacons', () => {
    expect(
      assetsOf(
        '{"ASSETS":[{"URI":"a.m3u8","DURATION":10},{"URI":"b.m3u8"}]}',
        'https://ads.example/x/list.json',
      ),
    ).toEqual([
      { url: 'https://ads.example/x/a.m3u8', duration: 10 },
      { url: 'https://ads.example/x/b.m3u8' },
    ]);
    const list = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="list">
  <Period id="1">
    <ImportedMPD>https://ads.example/one/manifest.mpd</ImportedMPD>
    <EventStream schemeIdUri="urn:mpeg:dash:event:callback:2015" value="1" timescale="1000">
      <Event presentationTime="0" id="1">https://ads.example/beacon/impression</Event>
      <Event presentationTime="5000" id="2">https://ads.example/beacon/midpoint</Event>
    </EventStream>
  </Period>
</MPD>`;
    expect(assetsOf(list, 'https://ads.example/ads?break=1')).toEqual([
      {
        url: 'https://ads.example/one/manifest.mpd',
        mimeType: 'application/dash+xml',
        tracking: [
          { offset: 0, url: 'https://ads.example/beacon/impression' },
          { offset: 5, url: 'https://ads.example/beacon/midpoint' },
        ],
      },
    ]);
    // An ordinary MPD is the asset itself.
    expect(assetsOf('<MPD type="static"/>', 'https://ads.example/ad.mpd')).toEqual([
      { url: 'https://ads.example/ad.mpd', mimeType: 'application/dash+xml' },
    ]);
  });
});

function harness(initial: Presentation, stage = interstitials()) {
  const element = Object.assign(new EventTarget(), {
    currentTime: 0,
    duration: 60,
    paused: true,
    ended: false,
    seeking: false,
    playbackRate: 1,
    play() {
      element.paused = false;
      return Promise.resolve();
    },
  });
  let state = {
    presentation: initial,
    live: null,
    tracks: { active: new Map(), available: [] },
  } as unknown as KernelState;
  const events: Array<[string, Record<string, unknown>]> = [];
  const transforms: TransformStep[] = [];
  const loads: Array<[string, unknown]> = [];
  const preloads: string[] = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  let api: InterstitialsApi | null = null;
  const fire = (event: string, payload: unknown = {}) => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  };
  const teardown = stage.install({
    element,
    getState: () => state,
    registerNamespace: (_name: string, value: InterstitialsApi) => {
      api = value;
    },
    emit: (event: string, payload: Record<string, unknown>) => events.push([event, payload]),
    on: (event: string, fn: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => undefined;
    },
    load: (url: string, options: unknown) => {
      loads.push([url, options]);
      fire('lifecycle:loading', { url });
      state = { ...state, presentation: null } as KernelState;
    },
    preload: async (url: string) => {
      preloads.push(url);
    },
    request: async (url: string) => ({
      ok: true,
      status: 200,
      url,
      text: async () =>
        '{"ASSETS":[{"URI":"one.m3u8","DURATION":5},{"URI":"two.m3u8","DURATION":5}]}',
    }),
    dispatch: () => undefined,
    registerTransform: (step: TransformStep) => {
      transforms.push(step);
    },
  } as unknown as StageContext);
  const h = {
    teardown: () => (teardown as () => void)?.(),
    api: () => api as InterstitialsApi,
    element,
    events,
    names: () => events.map(([name]) => name.replace('interstitials:', '')),
    loads,
    preloads,
    /** The page loads a source, from a position when given. */
    loading(url: string, start?: number) {
      fire('lifecycle:loading', start === undefined ? { url } : { url, start });
    },
    /** The page loads the presentation. */
    start() {
      fire('lifecycle:loading', { url: MASTER });
      h.ready(initial);
    },
    /** A load's presentation arrives. */
    ready(next: Presentation) {
      state = { ...state, presentation: next } as KernelState;
      fire('tracks:changed');
    },
    /** The kernel's view of the playhead's tracks and the live window. */
    set(extra: Partial<Record<'live' | 'tracks', unknown>>) {
      state = { ...state, ...extra } as KernelState;
    },
    /** Runs a media segment through the stage's emsg transform. */
    segment(data: Uint8Array, start: number) {
      return transforms[0]?.transform(data, {
        trackId: 'sb:video',
        renditionId: 'v0',
        contentType: 'video',
        seq: 0,
        start,
        duration: 4,
        isInit: false,
      });
    },
    /** Plays to a time, with a time update every quarter second as a browser gives them. */
    play(to: number) {
      element.paused = false;
      while (element.currentTime < to) {
        element.currentTime = Math.min(to, element.currentTime + 0.25);
        element.dispatchEvent(new Event('timeupdate'));
      }
    },
    seek(to: number) {
      element.seeking = true;
      element.dispatchEvent(new Event('seeking'));
      element.currentTime = to;
      element.seeking = false;
      element.dispatchEvent(new Event('seeked'));
    },
    /** The asset plays to its end. */
    end() {
      element.ended = true;
      element.dispatchEvent(new Event('ended'));
      element.ended = false;
    },
    /** The return to the presentation lands on its resume point. */
    back(to: number, next = initial) {
      h.ready({ ...next, id: `${next.id}-again` });
      element.currentTime = to;
      element.dispatchEvent(new Event('seeked'));
    },
  };
  element.addEventListener('play', () => undefined);
  return h;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ascii = (text: string) => [...new TextEncoder().encode(text)];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
/** A version 0 emsg box (ISO/IEC 23009-1 §5.10.3.3.3). */
function emsg(
  scheme: string,
  time: number,
  duration: number,
  id: number,
  body: string,
): Uint8Array {
  const payload = [
    0,
    0,
    0,
    0,
    ...ascii(scheme),
    0,
    0,
    ...u32(1),
    ...u32(time),
    ...u32(duration),
    ...u32(id),
    ...ascii(body),
  ];
  return new Uint8Array([...u32(8 + payload.length), ...ascii('emsg'), ...payload]);
}

/** The presentation with 4 s segments on its video, as an HLS media playlist gives them. */
function segmented(ranges: readonly DateRange[]): Presentation {
  const base = presentation(ranges);
  const period = base.periods[0];
  const track = period?.tracks[0];
  const rendition = track?.renditions[0];
  if (period === undefined || track === undefined || rendition === undefined)
    throw new Error('fixture');
  const segments = Array.from({ length: 15 }, (_, i) => ({
    seq: i,
    start: i * 4,
    duration: 4,
    url: `https://cdn.example/v/${i}.m4s`,
  }));
  return {
    ...base,
    periods: [{ ...period, tracks: [{ ...track, renditions: [{ ...rendition, segments }] }] }],
  };
}

describe('the interstitials stage', () => {
  it('preloads a mid-roll ahead, plays it at its start, and returns where it inserted', async () => {
    const h = harness(presentation([ad('mid', 20)]));
    h.start();
    h.play(12);
    await tick();
    expect(h.preloads).toContain('https://cdn.example/v/ads/mid.m3u8');
    h.play(20.1);
    await tick();
    expect(h.loads[0]).toEqual(['https://cdn.example/v/ads/mid.m3u8', {}]);
    expect(h.api().playing?.break.id).toBe('mid');
    expect(h.api().primary.currentTime).toBe(20);
    // The presentation is preloaded at the resume point while the asset plays.
    expect(h.preloads).toContain(MASTER);
    h.end();
    expect(h.loads[1]).toEqual([MASTER, { start: 20 }]);
    h.back(20);
    expect(h.names()).toEqual(['changed', 'break-start', 'asset-start', 'asset-end', 'break-end']);
    // Back at the start of the break, the break does not play again.
    h.play(21);
    await tick();
    expect(h.loads).toHaveLength(2);
  });

  it('plays a pre-roll before the first frame', async () => {
    const h = harness(presentation([ad('pre', 0, { CUE: 'PRE' })]));
    h.start();
    await tick();
    expect(h.loads[0]?.[0]).toBe('https://cdn.example/v/ads/pre.m3u8');
    h.end();
    expect(h.loads[1]).toEqual([MASTER, { start: 0 }]);
  });

  it('after a post-roll, the presentation comes back at its end, paused, and is over', async () => {
    const h = harness(presentation([ad('post', 0, { CUE: 'POST' })]));
    h.start();
    h.play(59.9);
    h.element.currentTime = 60;
    // The element's own end comes before the post-roll: not over yet.
    h.element.ended = true;
    expect(h.api().ended).toBe(false);
    h.element.dispatchEvent(new Event('ended'));
    h.element.ended = false;
    await tick();
    expect(h.loads[0]?.[0]).toBe('https://cdn.example/v/ads/post.m3u8');
    expect(h.api().ended).toBe(false);
    h.end();
    expect(h.loads[1]).toEqual([MASTER, { start: 60 }]);
    expect(h.names()).toContain('ended');
    expect(h.api().ended).toBe(true);
  });

  it('without a post-roll, the end of the presentation is the end', () => {
    const h = harness(presentation([ad('mid', 20)]));
    h.start();
    h.element.currentTime = 60;
    h.element.ended = true;
    expect(h.api().ended).toBe(true);
    h.element.dispatchEvent(new Event('ended'));
    expect(h.names()).toContain('ended');
    expect(h.loads).toHaveLength(0);
  });

  it('X-SNAP starts the break at the segment boundary before it, and returns at the one after', async () => {
    const h = harness(segmented([ad('snap', 21, { 'X-SNAP': 'OUT,IN', 'X-RESUME-OFFSET': '1' })]));
    h.set({ tracks: { active: new Map([['video', 'video']]), available: ['video'] } });
    h.start();
    h.play(20.1);
    await tick();
    expect(h.loads[0]?.[0]).toBe('https://cdn.example/v/ads/snap.m3u8');
    h.end();
    // 21 + 1 lands at 22, inside the segment from 20 to 24: it returns at 24.
    expect(h.loads[1]).toEqual([MASTER, { start: 24 }]);
  });

  it('live, the broadcast resumes where the break says on the reloaded timeline', async () => {
    const live = { ...presentation([ad('live', 100, { 'X-RESUME-OFFSET': '20' })]), isLive: true };
    const h = harness(live);
    h.set({ live: { span: { start: 40, end: 130 }, edge: 128 } });
    h.start();
    h.element.currentTime = 99;
    h.play(100.2);
    await tick();
    h.end();
    // Live returns without a start: the reload begins at the edge.
    expect(h.loads[1]).toEqual([MASTER, {}]);
    // The reload's clock starts again: the same break now starts at 10.
    h.set({ live: { span: { start: 0, end: 60 }, edge: 58 } });
    h.ready({
      ...presentation([ad('live', 10, { 'X-RESUME-OFFSET': '20' })]),
      id: 'again',
      isLive: true,
    });
    expect(h.element.currentTime).toBe(30);
  });

  it('reads a DASH alternative MPD replace from an emsg in the media', async () => {
    const h = harness(presentation([]));
    h.start();
    const body =
      '<ReplacePresentation uri="https://ads.example/alt.mpd" returnOffset="8" maxDuration="8"/>';
    await h.segment(emsg('urn:mpeg:dash:event:alternativeMPD:replace:2025', 2, 8, 7, body), 20);
    const [entry] = h.api().breaks;
    expect(entry).toMatchObject({
      id: '7',
      source: 'dash',
      start: 22,
      covers: 8,
      resumeOffset: 8,
      playoutLimit: 8,
      assetList: 'https://ads.example/alt.mpd',
    });
  });

  it('a pre-roll played before a detach does not play again when the programme resumes from a position', async () => {
    const stage = interstitials();
    const first = harness(presentation([ad('pre', 0, { CUE: 'PRE' })]), stage);
    first.start();
    await tick();
    first.end();
    first.back(0);
    first.play(10);
    // A progressive ad plays on the video: the engine detaches, then loads the programme at 10 s.
    first.teardown();
    const second = harness(presentation([ad('pre', 0, { CUE: 'PRE' })]), stage);
    second.loading(MASTER, 10);
    second.ready(presentation([ad('pre', 0, { CUE: 'PRE' })]));
    await tick();
    expect(second.loads).toHaveLength(0);
    // A fresh load of it, without a position, plays it again.
    const third = harness(presentation([ad('pre', 0, { CUE: 'PRE' })]), stage);
    third.start();
    await tick();
    expect(third.loads[0]?.[0]).toBe('https://cdn.example/v/ads/pre.m3u8');
  });

  it('a seek past a break that may not be jumped plays it, then goes to the seek target', async () => {
    const h = harness(presentation([ad('mid', 20, { 'X-RESTRICT': 'JUMP' })]));
    h.start();
    h.play(5);
    h.seek(45);
    await tick();
    expect(h.loads[0]?.[0]).toBe('https://cdn.example/v/ads/mid.m3u8');
    h.end();
    expect(h.loads[1]).toEqual([MASTER, { start: 45 }]);
  });

  it('a seek past an ordinary break skips it', async () => {
    const h = harness(presentation([ad('mid', 20)]));
    h.start();
    h.play(5);
    h.seek(45);
    await tick();
    expect(h.loads).toHaveLength(0);
  });

  it('plays each asset of an asset list in turn, and refuses a skip where the break forbids it', async () => {
    const h = harness(
      presentation([
        range('list', 20, {
          CLASS: 'com.apple.hls.interstitial',
          'X-ASSET-LIST': 'list.json',
          'X-RESTRICT': 'SKIP',
        }),
      ]),
    );
    h.start();
    h.play(20.1);
    await tick();
    await tick();
    expect(h.loads.map(([url]) => url)).toEqual(['https://cdn.example/v/one.m3u8']);
    expect(h.api().skip()).toBe(false);
    h.end();
    expect(h.loads.map(([url]) => url)).toEqual([
      'https://cdn.example/v/one.m3u8',
      'https://cdn.example/v/two.m3u8',
    ]);
    h.end();
    expect(h.loads[2]).toEqual([MASTER, { start: 20 }]);
    // Two assets of 5 s inserted before 20 s: the seek bar's timeline counts them.
    h.back(20);
    expect(h.api().integrated.currentTime).toBe(30);
    expect(h.api().integrated.duration).toBe(70);
  });

  it('a page pre-roll that arrives just after the start still plays, and skips from its skipAfter', async () => {
    const h = harness(presentation([]));
    h.start();
    h.play(0.5);
    h.element.dispatchEvent(new Event('playing'));
    h.api().schedule({
      cue: 'pre',
      start: 0,
      noSkip: true,
      skipAfter: 5,
      assets: [{ url: 'https://ads.example/pre.m3u8', duration: 15 }],
    });
    await tick();
    expect(h.loads[0]?.[0]).toBe('https://ads.example/pre.m3u8');
    h.element.currentTime = 2;
    expect(h.api().skip()).toBe(false);
    h.element.currentTime = 6;
    expect(h.api().skip()).toBe(true);
    expect(h.loads[1]).toEqual([MASTER, { start: 0 }]);
  });

  it('reports a cue-out the presentation plays through, and a page can fill it', async () => {
    const cue = range('cue-out-12', 24, { 'CUE-OUT': '8' }, 32);
    const h = harness(presentation([cue]));
    h.start();
    expect(h.names()).toContain('opportunity');
    h.play(24.5);
    h.play(28.5);
    h.play(32.5);
    expect(h.names().filter((n) => n !== 'changed')).toEqual([
      'opportunity',
      'break-start',
      'progress',
      'progress',
      'progress',
      'break-end',
    ]);
    expect(h.loads).toHaveLength(0);

    const filled = harness(presentation([cue]));
    filled.start();
    filled.api().schedule({
      id: 'cue-out-12',
      start: 24,
      covers: 8,
      assets: [{ url: 'https://ads.example/fill.m3u8', duration: 8 }],
    });
    filled.play(24.2);
    await tick();
    expect(filled.loads[0]?.[0]).toBe('https://ads.example/fill.m3u8');
    filled.end();
    // The fill replaced the span: the presentation resumes after it.
    expect(filled.loads[1]).toEqual([MASTER, { start: 32 }]);
  });

  it('seeks on either playhead, cancels a page break, and follows the viewer through a break', async () => {
    const h = harness(presentation([ad('mid', 20)]));
    h.start();
    // Before a break the presentation's time is the element's, and the
    // integrated time adds nothing.
    h.api().primary.seek(5);
    expect(h.element.currentTime).toBe(5);
    h.api().integrated.seek(10);
    expect(h.element.currentTime).toBe(10);
    const page = h.api().schedule({ start: 40, assets: [{ url: 'https://ads.example/p.m3u8' }] });
    expect(h.api().breaks.map((b) => b.id)).toContain(page.id);
    h.api().cancel(page.id);
    expect(h.api().breaks.map((b) => b.id)).not.toContain(page.id);
    h.play(20.1);
    await tick();
    expect(h.api().playing?.break.id).toBe('mid');
    expect(h.api().integrated.currentTime).toBeGreaterThanOrEqual(20);
    // The viewer pauses and plays the asset; the element can play again.
    h.element.dispatchEvent(new Event('pause'));
    h.element.dispatchEvent(new Event('play'));
    h.element.dispatchEvent(new Event('canplay'));
    // A seek of the presentation during the break ends it there.
    h.api().primary.seek(30);
    expect(h.loads[1]).toEqual([MASTER, { start: 30 }]);
  });
});
