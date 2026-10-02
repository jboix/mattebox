// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import textTtml from '../../../src/stages/text-ttml/index.js';
import { parseTime, parseTtml } from '../../../src/stages/text-ttml/parse.js';
import type { CueDescriptor } from '../../../src/types/messages.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { ParserFn, StageContext } from '../../../src/types/stage.js';

const RATES = { frame: 25, subFrame: 1, tick: 10_000_000 };

function tt(body: string, head = '', root = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="en" ${root}>
  <head>${head}</head>
  <body>${body}</body>
</tt>`;
}

const brief = (cues: readonly CueDescriptor[]) => cues.map((c) => [c.start, c.end, c.text]);

describe('TTML time expressions', () => {
  it('reads clock times with fractions, frames, and sub-frames', () => {
    expect(parseTime('00:01:02.5', RATES)).toBe(62.5);
    expect(parseTime('01:00:00:10', RATES)).toBe(3600.4);
    expect(parseTime('00:00:01:05.1', { ...RATES, subFrame: 2 })).toBeCloseTo(1.22, 6);
  });

  it('reads offset times in every metric', () => {
    expect(parseTime('1.5h', RATES)).toBe(5400);
    expect(parseTime('2m', RATES)).toBe(120);
    expect(parseTime('12.5s', RATES)).toBe(12.5);
    expect(parseTime('250ms', RATES)).toBe(0.25);
    expect(parseTime('50f', RATES)).toBe(2);
    expect(parseTime('35000000t', RATES)).toBe(3.5);
    expect(parseTime('soon', RATES)).toBeNull();
  });
});

describe('TTML documents to cues', () => {
  it('nests timing through div, p, and span, and splits a p where a span starts', () => {
    const cues = parseTtml(
      tt(`<div begin="10s">
        <p begin="1s" end="5s">Hello <span begin="2s">world</span></p>
        <p begin="00:00:06.000" dur="1s">Bye</p>
      </div>`),
    );
    // The span begins 2 s into its p, which begins at 11 s.
    expect(brief(cues)).toEqual([
      [11, 13, 'Hello'],
      [13, 15, 'Hello world'],
      [16, 17, 'Bye'],
    ]);
  });

  it('reads frame and tick times with the root rates', () => {
    const frames = tt(
      '<div><p begin="00:00:01:12" end="00:00:02:00">f</p></div>',
      '',
      'ttp:frameRate="24"',
    );
    expect(brief(parseTtml(frames))).toEqual([[1.5, 2, 'f']]);
    const ticks = tt('<div><p begin="5000t" end="15000t">t</p></div>', '', 'ttp:tickRate="10000"');
    expect(brief(parseTtml(ticks))).toEqual([[0.5, 1.5, 't']]);
  });

  it('marks styles with tags, breaks lines, collapses white space, escapes markup', () => {
    const head = `<styling>
      <style xml:id="base" tts:fontStyle="italic"/>
      <style xml:id="loud" style="base" tts:fontWeight="bold"/>
    </styling>`;
    const cues = parseTtml(
      tt(
        `<div><p begin="0s" end="1s">
          a &lt; b<br/>  <span style="loud">both</span>
          <span tts:textDecoration="underline">under</span>
        </p></div>`,
        head,
      ),
    );
    expect(cues[0]?.text).toBe('a &lt; b\n<i><b>both</b></i> <u>under</u>');
  });

  it('places a cue at its region, in percent, pixels, or cells', () => {
    const head = `<layout>
      <region xml:id="bottom" tts:origin="10% 80%" tts:extent="80% 10%" tts:displayAlign="after" tts:textAlign="center"/>
      <region xml:id="top" tts:origin="192px 108px" tts:extent="1536px 216px"/>
      <region xml:id="cells" tts:origin="4c 0c" tts:extent="24c 3c" tts:displayAlign="center"/>
    </layout>`;
    const cues = parseTtml(
      tt(
        `<div>
          <p region="bottom" begin="0s" end="1s">b</p>
          <p region="top" begin="1s" end="2s">t</p>
          <p region="cells" begin="2s" end="3s">c</p>
        </div>`,
        head,
        'tts:extent="1920px 1080px"',
      ),
    );
    expect(cues.map((c) => c.settings)).toEqual([
      'position:50%,center size:80% line:90%,end align:center',
      'position:50%,center size:80% line:10%,start',
      'position:50%,center size:75% line:10%,center',
    ]);
    expect(cues[0]?.payload).toMatchObject({ origin: '10% 80%', textAlign: 'center' });
  });

  it('takes a region from body or div and its styles as a parent', () => {
    const head = `<layout><region xml:id="r" tts:origin="0% 0%" tts:extent="100% 20%" tts:color="yellow" tts:fontStyle="italic"/></layout>`;
    const cues = parseTtml(tt('<div region="r"><p begin="0s" end="1s">x</p></div>', head));
    expect(cues[0]?.text).toBe('<i>x</i>');
    expect(cues[0]?.settings).toBe('position:50%,center size:100% line:0%,start');
    expect(cues[0]?.payload).toMatchObject({ color: 'yellow' });
  });

  it('reads an EBU-TT-D document', () => {
    const doc = `<?xml version="1.0" encoding="UTF-8"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
  xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ebuttm="urn:ebu:tt:metadata"
  ttp:timeBase="media" ttp:cellResolution="50 30" xml:lang="de">
  <tt:head>
    <tt:metadata><ebuttm:documentMetadata/></tt:metadata>
    <tt:styling><tt:style xml:id="s0" tts:color="#FFFFFF" tts:backgroundColor="#000000"/></tt:styling>
    <tt:layout><tt:region xml:id="r0" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after"/></tt:layout>
  </tt:head>
  <tt:body><tt:div><tt:p xml:id="sub1" region="r0" begin="00:00:01.000" end="00:00:03.000">
    <tt:span style="s0">Guten Tag</tt:span>
  </tt:p></tt:div></tt:body>
</tt:tt>`;
    const [cue] = parseTtml(doc);
    expect([cue?.start, cue?.end, cue?.text]).toEqual([1, 3, 'Guten Tag']);
    expect(cue?.settings).toBe('position:50%,center size:80% line:90%,end');
  });

  it('leaves an open end open, ignores other time bases, and refuses non-XML', () => {
    expect(parseTtml(tt('<div><p begin="2s">open</p></div>'))[0]?.end).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(
      parseTtml(tt('<div><p begin="0s" end="1s">x</p></div>', '', 'ttp:timeBase="smpte"')),
    ).toEqual([]);
    expect(() => parseTtml('WEBVTT\n\n00:00.000 --> 00:01.000\nx')).toThrow(RangeError);
  });
});

// The stage, through its parsers. jsdom has no TextTrackList; the sink is
// not asked for a native track here.
function parsers(): Map<string, ParserFn> {
  const map = new Map<string, ParserFn>();
  textTtml().install({
    element: { textTracks: new EventTarget() },
    registerSink() {},
    registerParser: (format: string, parse: ParserFn) => map.set(format, parse),
    getState: () => ({ presentation: null, tracks: { active: new Map() } }),
    on: () => () => undefined,
    dispatch() {},
  } as unknown as StageContext);
  return map;
}

const META: SegmentMeta = {
  trackId: 'subs',
  renditionId: 's1',
  contentType: 'text',
  seq: 3,
  start: 20,
  duration: 4,
  isInit: false,
};

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const box = (type: string, body: number[]) => [
  ...u32(8 + body.length),
  ...[...type].map((c) => c.charCodeAt(0)),
  ...body,
];

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

/** One fragment with one sample holding `xml`, decoding at `decode`, lasting `duration` (timescale units). */
function fragment(xml: string, decode: number, duration: number): Uint8Array {
  const bytes = [...new TextEncoder().encode(xml)];
  const build = (offset: number) =>
    box(
      'moof',
      box('traf', [
        ...box('tfhd', [0, 0x02, 0, 0, ...u32(1)]),
        ...box('tfdt', [0, 0, 0, 0, ...u32(decode)]),
        ...box('trun', [
          0,
          0,
          0x03,
          0x01,
          ...u32(1),
          ...u32(offset),
          ...u32(duration),
          ...u32(bytes.length),
        ]),
      ]),
    );
  const moof = build(0);
  return Uint8Array.from([...build(moof.length + 8), ...box('mdat', bytes)]);
}

describe('the text-ttml stage', () => {
  it('parses a sidecar on the presentation timeline, closing open ends at the segment end', () => {
    const parse = parsers().get('application/ttml+xml') as ParserFn;
    const doc = tt('<div><p begin="21s" end="22s">a</p><p begin="23s">b</p></div>');
    const cues = parse(new TextEncoder().encode(doc), META);
    expect(brief(cues)).toEqual([
      [21, 22, 'a'],
      [23, 24, 'b'],
    ]);
    expect(cues[0]?.id).toBe('21.000|22.000|a');
  });

  it('maps stpp sample times through the decode time, absolute or from the sample start', () => {
    const parse = parsers().get('application/mp4;stpp') as ParserFn;
    expect(parse(init(1000), { ...META, isInit: true, seq: -1 })).toEqual([]);
    // Media clock 100 s at the segment start (presentation 20 s).
    const absolute = fragment(tt('<div><p begin="101s" end="102s">abs</p></div>'), 100_000, 4000);
    expect(brief(parse(absolute, META))).toEqual([[21, 22, 'abs']]);
    const relative = fragment(tt('<div><p begin="1s" end="2s">rel</p></div>'), 100_000, 4000);
    expect(brief(parse(relative, META))).toEqual([[21, 22, 'rel']]);
    const open = fragment(tt('<div><p begin="1s">open</p></div>'), 100_000, 4000);
    expect(brief(parse(open, META))).toEqual([[21, 24, 'open']]);
  });
});
