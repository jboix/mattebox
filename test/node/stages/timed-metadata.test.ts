import { describe, expect, it } from 'vitest';
import { deliverMetadata } from '../../../src/containers/metadata.js';
import timedMetadata, { type MetadataApi } from '../../../src/stages/timed-metadata/index.js';
import type { DateRange, Presentation, PresentationEvent } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

function presentation(
  ranges: readonly DateRange[][],
  events: readonly PresentationEvent[] = [],
  id = 'https://cdn.example/master.m3u8',
): Presentation {
  return {
    id,
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
            renditions: ranges.map((dateRanges, i) => ({
              id: `v${i}`,
              bitrate: i,
              codecs: null,
              mimeType: 'video/mp4',
              segments: [],
              dateRanges,
            })),
          },
        ],
        events,
      },
    ],
  };
}

const SEGMENT: SegmentMeta = {
  trackId: 'sb:video',
  renditionId: 'v0',
  contentType: 'video',
  seq: 3,
  start: 30,
  duration: 6,
  isInit: false,
};

const ascii = (text: string) => [...new TextEncoder().encode(text)];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...ascii(type), ...body];

/** An emsg box, version 0 or 1 (ISO/IEC 23009-1 §5.10.3.3.3). */
function emsg(
  version: 0 | 1,
  e: {
    scheme: string;
    value?: string;
    timescale: number;
    time: number;
    duration: number;
    id: number;
  },
  data: number[],
): number[] {
  const strings = [...ascii(e.scheme), 0, ...ascii(e.value ?? ''), 0];
  const body =
    version === 0
      ? [...strings, ...u32(e.timescale), ...u32(e.time), ...u32(e.duration), ...u32(e.id)]
      : [
          ...u32(e.timescale),
          ...u32(0),
          ...u32(e.time),
          ...u32(e.duration),
          ...u32(e.id),
          ...strings,
        ];
  return box('emsg', [version, 0, 0, 0, ...body, ...data]);
}

/** An init with one track of `timescale`, and a fragment of it decoding from `decode`. */
function initSegment(timescale: number): Uint8Array {
  const tkhd = box('tkhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0)]);
  const mdhd = box('mdhd', [
    0,
    0,
    0,
    0,
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(0),
    0,
    0,
    0,
    0,
  ]);
  return Uint8Array.from(box('moov', box('trak', [...tkhd, ...box('mdia', mdhd)])));
}
function moof(decode: number): number[] {
  const tfhd = box('tfhd', [0, 0, 0, 0, ...u32(1)]);
  const tfdt = box('tfdt', [0, 0, 0, 0, ...u32(decode)]);
  return box('moof', box('traf', [...tfhd, ...tfdt]));
}

/** SCTE 35 §14.3: a splice_insert out of network with a 60.29 s break. */
const SPLICE_INSERT = '/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=';

function range(id: string, start: number, extra: Partial<DateRange> = {}): DateRange {
  return { id, start, startDate: 1_790_942_400 + start, attributes: { ID: id }, ...extra };
}

/** A stage over a fake element whose time the test moves. */
function harness(initial: Presentation) {
  const element = Object.assign(new EventTarget(), {
    currentTime: 0,
    paused: true,
    seeking: false,
    playbackRate: 1,
  });
  let state = { presentation: initial, live: null } as unknown as KernelState;
  const emitted: Array<[string, string]> = [];
  const listeners = new Map<string, Array<() => void>>();
  let api: MetadataApi | null = null;
  const transforms: TransformStep[] = [];
  timedMetadata().install({
    element,
    registerTransform: (step: TransformStep) => transforms.push(step),
    getState: () => state,
    registerNamespace: (_name: string, value: MetadataApi) => {
      api = value;
    },
    emit: (event: string, payload: { id: string }) => emitted.push([event, payload.id]),
    on: (event: string, fn: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => undefined;
    },
  } as unknown as StageContext);
  return {
    api: () => api as MetadataApi,
    emitted,
    /** Runs a segment through the stage's emsg transform. */
    async segment(data: Uint8Array, meta: Partial<SegmentMeta> = {}) {
      const out = await transforms[0]?.transform(data, { ...SEGMENT, ...meta });
      expect(out).toBe(data);
    },
    load(next: Presentation) {
      state = { ...state, presentation: next } as KernelState;
      for (const fn of listeners.get('tracks:changed') ?? []) fn();
    },
    play(to: number) {
      element.currentTime = to;
      element.dispatchEvent(new Event('timeupdate'));
    },
    seek(to: number) {
      element.seeking = true;
      element.currentTime = to;
      element.seeking = false;
      element.dispatchEvent(new Event('seeked'));
    },
  };
}

describe('timed-metadata', () => {
  it('lists date ranges merged across renditions, and EventStream events, by start', () => {
    const h = harness(
      presentation(
        [
          [
            range('splice', 10, {
              plannedEnd: 40,
              attributes: { ID: 'splice', 'SCTE35-OUT': '0xFC00' },
            }),
          ],
          // The other variant's playlist repeats it and adds the in.
          [range('splice', 10, { end: 39.5, attributes: { ID: 'splice', 'SCTE35-IN': '0xFC01' } })],
        ],
        [{ scheme: 'urn:example', id: '1', start: 5, duration: 2, data: 'hi' }],
      ),
    );
    const events = h.api().events;
    expect(events.map((e) => [e.id, e.source, e.start, e.end])).toEqual([
      ['urn:example|1', 'eventstream', 5, 7],
      ['splice', 'daterange', 10, 39.5],
    ]);
    expect(events[1]?.attributes).toMatchObject({ 'SCTE35-OUT': '0xFC00', 'SCTE35-IN': '0xFC01' });
    expect([...(events[1]?.data ?? [])]).toEqual([0xfc, 0x00]);
  });

  it('enters and exits spans as playback crosses them, and fires an instant once', () => {
    const h = harness(
      presentation([[range('span', 2, { end: 4 }), range('point', 3, { end: 3 })]]),
    );
    h.api().events;
    h.play(1);
    h.play(2.5);
    h.play(3.5);
    h.play(4.5);
    expect(h.emitted.filter(([e]) => e !== 'metadata:added')).toEqual([
      ['metadata:enter', 'span'],
      ['metadata:enter', 'point'],
      ['metadata:exit', 'point'],
      ['metadata:exit', 'span'],
    ]);
  });

  it('a seek exits what it leaves and enters what it lands in, skipping instants', () => {
    const h = harness(
      presentation([
        [range('a', 0, { end: 10 }), range('b', 20, { end: 30 }), range('p', 15, { end: 15 })],
      ]),
    );
    h.play(1);
    h.seek(25);
    expect(h.emitted.filter(([e]) => e !== 'metadata:added')).toEqual([
      ['metadata:enter', 'a'],
      ['metadata:exit', 'a'],
      ['metadata:enter', 'b'],
    ]);
  });

  it('an open span stays entered until its end arrives', () => {
    const open = range('out', 2);
    const h = harness(presentation([[open]]));
    h.play(3);
    expect(
      h
        .api()
        .at(100)
        .map((e) => e.id),
    ).toEqual(['out']);
    h.load(presentation([[{ ...open, end: 5 }]]));
    h.play(6);
    expect(h.emitted.filter(([e]) => e !== 'metadata:added')).toEqual([
      ['metadata:enter', 'out'],
      ['metadata:exit', 'out'],
    ]);
  });

  it('takes records the media delivers, and a new source empties the list', () => {
    const h = harness(presentation([[]]));
    deliverMetadata([
      { id: 'id3@3', source: 'id3', scheme: 'id3', start: 3, end: 3, attributes: {} },
    ]);
    expect(h.api().events.map((e) => e.id)).toEqual(['id3@3']);
    h.load(presentation([[]], [], 'https://cdn.example/next.m3u8'));
    expect(h.api().events).toEqual([]);
  });

  it('a rebuilt but unchanged record is not added again', () => {
    const h = harness(presentation([[range('a', 1, { end: 2 })]]));
    h.api().events;
    h.load(presentation([[range('a', 1, { end: 2 })]]));
    h.api().events;
    expect(h.emitted.filter(([e]) => e === 'metadata:added')).toEqual([['metadata:added', 'a']]);
  });

  it('places emsg version 0 from the segment start and version 1 through the decode time', async () => {
    const h = harness(presentation([[]]));
    await h.segment(initSegment(1000), { isInit: true, seq: -1 });
    const segment = Uint8Array.from([
      ...emsg(
        0,
        { scheme: 'urn:a', value: 'x', timescale: 1000, time: 1500, duration: 2000, id: 1 },
        [7],
      ),
      // Media clock 100 s at the segment start, so 104 s is 4 s in.
      ...emsg(1, { scheme: 'urn:b', timescale: 10, time: 1040, duration: 0xffffffff, id: 2 }, []),
      ...moof(100_000),
    ]);
    await h.segment(segment);
    expect(h.api().events.map((e) => [e.id, e.source, e.value, e.start, e.end])).toEqual([
      ['urn:a|x|1', 'emsg', 'x', 31.5, 33.5],
      ['urn:b||2', 'emsg', undefined, 34, null],
    ]);
    // The next segment repeats the open event: still one record, not added again.
    await h.segment(segment, { seq: 4 });
    expect(h.api().events).toHaveLength(2);
    expect(h.emitted.filter(([e]) => e === 'metadata:added')).toHaveLength(2);
  });

  it('skips a version 1 emsg it cannot place without the init', async () => {
    const h = harness(presentation([[]]));
    await h.segment(
      Uint8Array.from([
        ...emsg(1, { scheme: 'urn:b', timescale: 10, time: 1040, duration: 0, id: 2 }, []),
        ...moof(100_000),
      ]),
    );
    expect(h.api().events).toEqual([]);
  });

  it('decodes ID3 in emsg and summarizes SCTE-35 in emsg, date ranges, and EventStream', async () => {
    const section = [...atob(SPLICE_INSERT)].map((c) => c.charCodeAt(0));
    const hex = `0x${section.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const h = harness(
      presentation(
        [[range('ad', 1, { attributes: { ID: 'ad', 'SCTE35-OUT': hex } })]],
        [{ scheme: 'urn:scte:scte35:2013:bin', id: '9', start: 2, data: `\n  ${SPLICE_INSERT}\n` }],
      ),
    );
    const tag = [
      0x49,
      0x44,
      0x33,
      4,
      0,
      0,
      0,
      0,
      0,
      15,
      ...ascii('TIT2'),
      0,
      0,
      0,
      5,
      0,
      0,
      3,
      ...ascii('news'),
    ];
    await h.segment(
      Uint8Array.from([
        ...emsg(
          0,
          { scheme: 'https://aomedia.org/emsg/ID3', timescale: 1, time: 0, duration: 0, id: 3 },
          tag,
        ),
        ...emsg(
          0,
          { scheme: 'urn:scte:scte35:2013:bin', timescale: 1, time: 1, duration: 60, id: 4 },
          section,
        ),
        ...moof(0),
      ]),
    );
    const byId = new Map(h.api().events.map((e) => [e.id, e]));
    expect(byId.get('https://aomedia.org/emsg/ID3||3')?.frames?.[0]).toMatchObject({
      id: 'TIT2',
      value: 'news',
    });
    const summary = {
      commandType: 5,
      eventId: 0x4800008f,
      cancel: false,
      outOfNetwork: true,
      segmentations: [],
    };
    for (const id of ['ad', 'urn:scte:scte35:2013:bin|9', 'urn:scte:scte35:2013:bin||4']) {
      expect(byId.get(id)?.scte35).toMatchObject(summary);
      expect(byId.get(id)?.scte35?.breakDuration).toBeCloseTo(5_426_421 / 90_000, 9);
    }
  });
});
