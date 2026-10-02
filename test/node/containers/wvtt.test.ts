import { describe, expect, it } from 'vitest';
import textWebvtt from '../../../src/stages/text-webvtt/index.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { ParserFn, StageContext } from '../../../src/types/stage.js';

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const text = (s: string) => [...new TextEncoder().encode(s)];
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...text(type), ...body];
const cue = (payload: string, settings?: string) =>
  box('vttc', [
    ...(settings !== undefined ? box('sttg', text(settings)) : []),
    ...box('payl', text(payload)),
  ]);

function init(timescale: number): Uint8Array {
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

/** One fragment of samples, each `duration` long, decoding from `decode`. */
function fragment(samples: number[][], decode: number, duration: number): Uint8Array {
  const data = samples.flat();
  const entries = samples.flatMap((s) => [...u32(duration), ...u32(s.length)]);
  const build = (offset: number) =>
    box(
      'moof',
      box('traf', [
        ...box('tfhd', [0, 0x02, 0, 0, ...u32(1)]),
        ...box('tfdt', [0, 0, 0, 0, ...u32(decode)]),
        ...box('trun', [0, 0, 0x03, 0x01, ...u32(samples.length), ...u32(offset), ...entries]),
      ]),
    );
  const size = build(0).length;
  return Uint8Array.from([...build(size + 8), ...box('mdat', data)]);
}

function wvttParser(): ParserFn {
  const parsers = new Map<string, ParserFn>();
  textWebvtt().install({
    element: { textTracks: new EventTarget() },
    registerSink() {},
    registerParser: (format: string, parse: ParserFn) => parsers.set(format, parse),
    getState: () => ({ presentation: null, tracks: { active: new Map() } }),
    on: () => () => undefined,
    dispatch() {},
  } as unknown as StageContext);
  return parsers.get('application/mp4;wvtt') as ParserFn;
}

const META: SegmentMeta = {
  trackId: 'subs',
  renditionId: 's1',
  contentType: 'text',
  seq: 2,
  start: 10,
  duration: 8,
  isInit: false,
};

describe('WebVTT in fMP4', () => {
  it('places samples through the decode time, joins a cue across samples, and skips empty spans', () => {
    const parse = wvttParser();
    expect(parse(init(1000), { ...META, isInit: true, seq: -1 })).toEqual([]);
    // Media clock 500 s at the segment start (presentation 10 s), 2 s samples.
    const segment = fragment(
      [
        cue('Hello', 'line:90%'),
        cue('Hello', 'line:90%'),
        box('vtte', []),
        [...cue('a'), ...cue('b <i>c</i>')],
      ],
      500_000,
      2000,
    );
    expect(parse(segment, META).map((c) => [c.start, c.end, c.text, c.settings])).toEqual([
      [10, 14, 'Hello', 'line:90%'],
      [16, 18, 'a', undefined],
      [16, 18, 'b <i>c</i>', undefined],
    ]);
  });

  it('gives each cue an id from its time and text, so a refetch adds nothing twice', () => {
    const parse = wvttParser();
    parse(init(1000), { ...META, isInit: true, seq: -1 });
    const [first] = parse(fragment([cue('x')], 0, 1000), { ...META, start: 0 });
    expect(first?.id).toBe('0.000|1.000|x');
  });

  it('reads nothing before its init, rather than guessing the timescale', () => {
    expect(wvttParser()(fragment([cue('x')], 0, 1000), META)).toEqual([]);
  });
});
