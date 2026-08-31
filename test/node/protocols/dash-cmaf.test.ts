// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { segmentAt, segmentAtTime } from '../../../src/kernel/timeline.js';
import {
  mergeSidx,
  parse,
  parseDuration,
  sidxToSegments,
} from '../../../src/protocols/dash-cmaf/parse.js';
import type { IndexedSegments, Rendition, SidxSegments, Track } from '../../../src/types/ir.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/manifests');
const BASE = 'https://cdn.example/path/manifest.mpd';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function tracksOf(name: string): readonly Track[] {
  const result = parse(fixture(name), BASE);
  expect(result.error).toBeNull();
  return result.presentation?.periods[0]?.tracks ?? [];
}

function firstRendition(name: string): Rendition {
  const rendition = tracksOf(name).find((t) => t.contentType === 'video')?.renditions[0];
  if (rendition === undefined) throw new Error(`no rendition in ${name}`);
  return rendition;
}

function indexed(rendition: Rendition): IndexedSegments {
  const addressing = rendition.segments;
  if (!('kind' in addressing) || addressing.kind !== 'indexed') {
    throw new Error('expected indexed addressing');
  }
  return addressing;
}

function sidx(rendition: Rendition): SidxSegments {
  const addressing = rendition.segments;
  if (!('kind' in addressing) || addressing.kind !== 'sidx') {
    throw new Error('expected sidx addressing');
  }
  return addressing;
}

describe('on-demand profile: SegmentBase with a sidx index', () => {
  const NAME = 'shaka-angel-one-segmentbase.mpd';
  const SIDX = readFileSync(
    join(import.meta.dirname, '../../fixtures/segments/angel-one-video-sidx.bin'),
  );

  it('a text representation with only a BaseURL is one whole-file segment for the period', () => {
    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1M30S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.4d401f">
      <SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" duration="6" timescale="1" startNumber="1"/>
      <Representation id="v" bandwidth="800000" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" lang="de" mimeType="text/vtt">
      <Label>Deutsch</Label>
      <Representation id="de" bandwidth="0"><BaseURL>https://subs.example/de.vtt</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
      <Representation id="a-nofile" bandwidth="0"><BaseURL>https://cdn.example/whole.m4a</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const result = parse(mpd, BASE);
    expect(result.error).toBeNull();
    const tracks = result.presentation?.periods[0]?.tracks ?? [];
    const text = tracks.find((t) => t.contentType === 'text');
    expect(text?.lang).toBe('de');
    expect(text?.renditions[0]?.segments).toEqual([
      { seq: 0, start: 0, duration: 90, url: 'https://subs.example/de.vtt' },
    ]);
    // Media with neither addressing nor an index still cannot be scheduled.
    expect(tracks.some((t) => t.contentType === 'audio')).toBe(false);
  });

  it('parses SegmentBase into unresolved sidx addressing, not an empty manifest', () => {
    const result = parse(fixture(NAME), BASE);
    expect(result.error).toBeNull();
    const video = tracksOf(NAME).find((t) => t.contentType === 'video');
    expect(video).toBeDefined();
    const addressing = sidx(video?.renditions[0] as Rendition);
    expect(addressing.kind).toBe('sidx');
    expect(addressing.indexRange).toEqual({ start: 1094, end: 1305 });
    expect(addressing.url).toMatch(/\.mp4$/);
  });

  it('reads the Initialization@range as a byte-range init segment', () => {
    const init = firstRendition(NAME).init;
    expect(init?.byteRange).toEqual({ start: 0, end: 1093 });
    expect(init?.url).toBe(sidx(firstRendition(NAME)).url);
  });

  it('carries the Widevine ContentProtection through to the track', () => {
    const video = tracksOf(NAME).find((t) => t.contentType === 'video');
    const scheme = video?.protection?.schemes[0];
    expect(scheme?.systemId).toBe('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
    expect(scheme?.initData).not.toBeNull();
  });

  it('resolves the real sidx box into contiguous byte-range segments', () => {
    const addressing = sidx(firstRendition(NAME));
    const segments = sidxToSegments(new Uint8Array(SIDX), addressing);
    expect(segments.length).toBe(15);
    // First media byte is indexRange.end + 1 + firstOffset.
    expect(segments[0]?.byteRange?.start).toBe(1306);
    // Byte ranges are contiguous and durations sum to the declared 60s.
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.byteRange?.start).toBe((segments[i - 1]?.byteRange?.end ?? 0) + 1);
    }
    const total = segments.reduce((sum, s) => sum + s.duration, 0);
    expect(total).toBeCloseTo(60, 3);
  });

  it('merges resolved segments back into the rendition in place', () => {
    const parsed = parse(fixture(NAME), BASE).presentation;
    if (parsed === null) throw new Error('parse failed');
    const rid = parsed.periods[0]?.tracks.find((t) => t.contentType === 'video')?.renditions[0]
      ?.id as string;
    const segments = sidxToSegments(new Uint8Array(SIDX), sidx(firstRendition(NAME)));
    const merged = mergeSidx(parsed, rid, segments);
    const rendition = merged.periods[0]?.tracks
      .flatMap((t) => t.renditions)
      .find((r) => r.id === rid);
    if (rendition === undefined) throw new Error('merged rendition missing');
    expect(Array.isArray(rendition.segments)).toBe(true);
    expect((rendition.segments as unknown[]).length).toBe(15);
  });
});

describe('golden corpus: every MPD fixture parses to a stable IR', () => {
  const corpus = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.mpd') && !name.startsWith('malformed-'))
    .sort();

  it('the corpus holds real DASH-IF and Unified Streaming vectors', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of corpus) {
    it(`${name} parses to a stable IR`, () => {
      const result = parse(fixture(name), BASE);
      expect(result.error).toBeNull();
      expect(result.presentation).toMatchSnapshot();
    });
  }
});

describe('ISO 8601 durations', () => {
  it('parses the common forms', () => {
    expect(parseDuration('PT1M12.0S')).toBe(72);
    expect(parseDuration('PT0H10M54.00S')).toBe(654);
    expect(parseDuration('PT634.566S')).toBeCloseTo(634.566);
    expect(parseDuration('P1DT2H')).toBe(93_600);
    expect(parseDuration('nonsense')).toBeNull();
  });
});

describe('segment templating through the kernel', () => {
  it('$Number$ resolves against a constant-duration template', () => {
    const rendition = tracksOf('edge-nested-baseurl.mpd')[0]?.renditions.find(
      (r) => r.id === 'lo',
    ) as Rendition;
    const segment = segmentAt(rendition.segments, 3);
    expect(segment?.url).toBe('https://cdn-a.example/content/asset-42/video/lo/3.m4s');
    expect(segment?.start).toBe(8);
    expect(segment?.duration).toBe(4);
  });

  it('$Time$ resolves against a SegmentTimeline', () => {
    const rendition = firstRendition('edge-negative-r.mpd');
    const third = segmentAt(rendition.segments, 3);
    expect(third?.url).toBe('https://cdn.example/path/v/180000.m4s');
    expect(third?.start).toBe(2);
  });

  it('$Number%05d$ and $Bandwidth%08d$ zero-pad', () => {
    const rendition = tracksOf('edge-number-padding.mpd')[0]?.renditions.find(
      (r) => r.id === 'video-360',
    ) as Rendition;
    expect(rendition.init?.url).toBe('https://cdn.example/path/video-360/init-00800000.mp4');
    const segment = segmentAt(rendition.segments, 7);
    expect(segment?.url).toBe('https://cdn.example/path/video-360/seg-00007.m4s');
  });

  it('the ffmpeg-produced local stream materializes end to end', () => {
    const rendition = firstRendition('equiv-local-h264.mpd');
    const addressing = indexed(rendition);
    expect(addressing.endSeq).toBe(18);
    const first = segmentAt(addressing, 1);
    const last = segmentAt(addressing, 18);
    expect(first?.url).toBe('https://cdn.example/path/chunk-stream0-00001.m4s');
    expect(first?.start).toBe(0);
    expect(last?.start).toBe(68);
    expect(segmentAt(addressing, 19)).toBeNull();
  });
});

describe('SegmentTimeline repeat counts', () => {
  it('a negative @r runs to the next S@t, and on the last S to the period end', () => {
    const addressing = indexed(firstRendition('edge-negative-r.mpd'));
    expect(addressing.timeline).toEqual([
      // 20 x 1 s until the next S at t=1800000.
      { start: 0, duration: 90_000, count: 20 },
      // r=1 means two segments.
      { start: 1_800_000, duration: 180_000, count: 2 },
      // The remaining 36 s of the 60 s period in 4 s segments.
      { start: 2_160_000, duration: 360_000, count: 9 },
    ]);
    expect(addressing.endSeq).toBe(31);
    expect(segmentAt(addressing, 31)?.start).toBe(56);
  });
});

describe('BaseURL resolution', () => {
  it('nests MPD, Period, AdaptationSet, and Representation bases', () => {
    const track = tracksOf('edge-nested-baseurl.mpd')[0] as Track;
    const hi = track.renditions.find((r) => r.id === 'hi');
    expect(indexed(hi as Rendition).urlTemplate).toBe(
      'https://cdn-a.example/content/asset-42/video/hi-cdn/hi/$Number$.m4s',
    );
    expect(hi?.init?.url).toBe('https://cdn-a.example/content/asset-42/video/hi-cdn/hi/init.mp4');
  });
});

describe('@presentationTimeOffset is in timescale units', () => {
  it('shifts media time without shifting presentation time', () => {
    const addressing = indexed(firstRendition('edge-pto.mpd'));
    expect(addressing.presentationTimeOffset).toBe(900_000);
    const first = segmentAt(addressing, 5);
    // Media time carries the 10 s offset; presentation time starts at zero.
    expect(first?.url).toBe('https://cdn.example/path/900000.m4s');
    expect(first?.start).toBe(0);
    expect(first?.duration).toBe(4);
    // Lookup by presentation time honors the same mapping.
    expect(segmentAtTime(addressing, 9)?.seq).toBe(7);
  });
});

describe('protection descriptors, before any DRM stage exists', () => {
  it('ContentProtection yields schemes with the common key id and scheme', () => {
    const track = tracksOf('edge-contentprotection.mpd')[0] as Track;
    const schemes = track.protection?.schemes ?? [];
    expect(schemes).toHaveLength(2);
    const widevine = schemes.find((s) => s.systemId === 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
    expect(widevine?.scheme).toBe('cenc');
    expect(widevine?.keyId).toBe('9eb4050de44b4802932e27d75083e266');
    expect(widevine?.initDataType).toBe('cenc');
    expect(widevine?.initData?.byteLength).toBeGreaterThan(0);
    const playready = schemes.find((s) => s.systemId === '9a04f079-9840-4286-ab92-e65be0885f95');
    expect(playready?.initData).toBeNull();
  });
});

describe('generic track descriptors', () => {
  it('AdaptationSets map to tracks with contentType, lang, and role', () => {
    const tracks = tracksOf('edge-multitrack.mpd');
    expect(tracks.map((t) => t.contentType)).toEqual(['video', 'audio', 'text']);
    const audio = tracks[1] as Track;
    expect(audio.lang).toBe('fr');
    expect(audio.role).toBe('main');
    const video = tracks[0] as Track;
    expect(video.renditions[0]?.frameRate).toBeCloseTo(29.97, 2);
    const text = tracks[2] as Track;
    expect(text.role).toBe('subtitle');
    expect(text.renditions[0]?.codecs).toBe('stpp');
  });

  it('the coupling table is identity: empty', () => {
    const result = parse(fixture('edge-multitrack.mpd'), BASE);
    expect(result.presentation?.couplings).toEqual([]);
  });
});

describe('malformed MPDs fail with values, never throws', () => {
  for (const name of [
    'malformed-not-xml.mpd',
    'malformed-no-period.mpd',
    'malformed-wrong-root.mpd',
  ]) {
    it(`${name} yields a MatteboxError`, () => {
      const result = parse(fixture(name), BASE);
      expect(result.presentation).toBeNull();
      expect(result.error?.category).toBe('manifest');
      expect(['MANIFEST_PARSE_FAILED', 'MANIFEST_EMPTY']).toContain(result.error?.code);
    });
  }
});

describe('URL resolution at parse time', () => {
  it('every template and init URL in the IR is absolute', () => {
    for (const name of ['dashif-akamai-bbb.mpd', 'unified-tears.mpd', 'dashif-2c-timeline.mpd']) {
      const result = parse(fixture(name), BASE);
      for (const period of result.presentation?.periods ?? []) {
        for (const track of period.tracks) {
          for (const rendition of track.renditions) {
            expect(indexed(rendition).urlTemplate).toMatch(/^https:\/\//);
            if (rendition.init !== undefined) {
              expect(rendition.init.url).toMatch(/^https:\/\//);
            }
          }
        }
      }
    }
  });
});

describe('trick mode', () => {
  it('skips an I-frame-only AdaptationSet so it never becomes the video track', () => {
    const mpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT60S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period start="PT0S" id="1">
    <AdaptationSet id="9" mimeType="video/mp4" segmentAlignment="true">
      <EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="1"/>
      <Representation id="trick" width="320" height="180" frameRate="25/50" bandwidth="15624" codecs="avc1.42C00D" maxPlayoutRate="50">
        <SegmentTemplate timescale="25000" media="t_$Number$.mp4" initialization="t_init.mp4" startNumber="1" duration="150000"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="main" width="640" height="360" frameRate="25" bandwidth="1000000" codecs="avc1.4D401F">
        <SegmentTemplate timescale="25000" media="v_$Number$.mp4" initialization="v_init.mp4" startNumber="1" duration="150000"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="2" mimeType="audio/mp4">
      <Representation id="aud" bandwidth="96000" codecs="mp4a.40.2">
        <SegmentTemplate timescale="48000" media="a_$Number$.mp4" initialization="a_init.mp4" startNumber="1" duration="288000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const result = parse(mpd, 'https://cdn.example/live/index.mpd');
    expect(result.error).toBeNull();
    const tracks = result.presentation?.periods[0]?.tracks ?? [];
    const video = tracks.filter((t) => t.contentType === 'video');
    expect(video).toHaveLength(1);
    expect(video[0]?.renditions.map((r) => r.id)).toEqual(['main']);
    expect(tracks.some((t) => t.contentType === 'audio')).toBe(true);
  });
});
