import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAttributeList } from '../../../src/protocols/hls-cmaf/lexer.js';
import {
  mergePlaylist,
  normalizeAvcCodec,
  parse,
  parseMediaPlaylist,
} from '../../../src/protocols/hls-cmaf/parse.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/manifests');
const BASE = 'https://cdn.example/path/master.m3u8';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('golden corpus: every fixture parses to a stable IR', () => {
  const corpus = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.m3u8') && !name.startsWith('malformed-'))
    .sort();

  it('the corpus meets the fifteen-fixture bar', () => {
    expect(readdirSync(FIXTURES).filter((n) => n.endsWith('.m3u8')).length).toBeGreaterThanOrEqual(
      15,
    );
  });

  for (const name of corpus) {
    it(`${name} parses to a stable IR`, () => {
      const result = parse(fixture(name), BASE);
      expect(result.error).toBeNull();
      expect(result.presentation).toMatchSnapshot();
    });
  }
});

describe('muxed transport-stream variants', () => {
  function videoCodecs(name: string): Array<string | null> {
    const presentation = parse(fixture(name), BASE).presentation;
    const track = presentation?.periods[0]?.tracks.find((t) => t.contentType === 'video');
    return (track?.renditions ?? []).map((r) => r.codecs);
  }

  it('drops the audio-only STREAM-INF instead of opening a codec-less video buffer', () => {
    // Apple's bipbop lists an audio-only variant at the lowest bandwidth. It
    // must not survive as a video rendition: the no-abr default picks the
    // lowest bitrate, and a null codec opens a bare `video/mp4` SourceBuffer
    // that Chrome refuses.
    const codecs = videoCodecs('apple-bipbop-basic-master.m3u8');
    expect(codecs.length).toBeGreaterThan(0);
    expect(codecs).not.toContain(null);
  });

  it('carries both the video and muxed audio codec so the buffer declares both', () => {
    // No EXT-X-MEDIA audio group means the audio rides in the same segments,
    // so the transmux emits one fMP4 with two tracks and the buffer type must
    // name both codecs.
    for (const codec of videoCodecs('apple-bipbop-basic-master.m3u8')) {
      expect(codec).toMatch(/^avc1\.[0-9a-f]+, mp4a\.40\.2$/);
    }
  });

  it('promotes an all-audio STREAM-INF set to an audio track, not an empty video one', () => {
    // A radio or DVR audio stream lists only audio STREAM-INFs. Dropping them
    // as "not video" would leave nothing playable; they are the presentation.
    const presentation = parse(fixture('edge-audio-only-master.m3u8'), BASE).presentation;
    const tracks = presentation?.periods[0]?.tracks ?? [];
    expect(tracks.map((t) => t.contentType)).toEqual(['audio']);
    const audio = tracks[0];
    expect(audio?.renditions.map((r) => r.bitrate)).toEqual([192000, 96000]);
    expect(audio?.renditions.every((r) => r.codecs === 'mp4a.40.2')).toBe(true);
  });

  it('reads a bare packed-audio media playlist as an audio track', () => {
    // No master, no CODECS: a .aac segment set is a packed-audio presentation,
    // so the buffer must be audio/mp4, not a video buffer that rejects the AAC.
    const presentation = parse(fixture('edge-packed-audio-media.m3u8'), BASE).presentation;
    const track = presentation?.periods[0]?.tracks[0];
    expect(track?.contentType).toBe('audio');
    expect(track?.mimeType).toBe('audio/mp4');
    expect(
      Array.isArray(track?.renditions[0]?.segments) && track.renditions[0].segments.length,
    ).toBe(3);
  });

  it('normalizes legacy decimal AVC codecs on muxed variants', () => {
    // Unified's Tears of Steel declares avc1.66.30 (decimal). It must reach
    // the buffer as hex, paired with its muxed audio codec.
    const codecs = videoCodecs('unified-tears-master.m3u8');
    expect(codecs).not.toContain(null);
    expect(codecs).toContain('avc1.42001e, mp4a.40.2');
    expect(codecs.some((c) => c?.includes('.'))).toBe(true);
    expect(codecs.join(' ')).not.toMatch(/avc1\.\d+\.\d+/);
  });
});

describe('attribute lists', () => {
  it('quoted values containing commas survive', () => {
    const attrs = parseAttributeList(
      'TYPE=AUDIO,GROUP-ID="aud",NAME="Suisse, Romande",CODECS="avc1.64001f,mp4a.40.2",DEFAULT=YES',
    );
    expect(attrs.NAME).toBe('Suisse, Romande');
    expect(attrs.CODECS).toBe('avc1.64001f,mp4a.40.2');
    expect(attrs.DEFAULT).toBe('YES');
  });

  it('the quoted-comma fixture keeps the display name intact end to end', () => {
    const result = parse(fixture('edge-quoted-commas.m3u8'), BASE);
    const audio = result.presentation?.periods[0]?.tracks.find((t) => t.contentType === 'audio');
    expect(audio?.id).toBe('aud:Suisse, Romande');
  });
});

describe('byteranges', () => {
  it('explicit offsets, continuation, and the MAP byterange all resolve', () => {
    const result = parseMediaPlaylist(fixture('edge-byterange.m3u8'), BASE);
    expect(result.error).toBeNull();
    const playlist = result.playlist;
    expect(playlist?.init).toEqual({
      url: 'https://cdn.example/path/all.mp4',
      byteRange: { start: 0, end: 719 },
    });
    expect(playlist?.segments.map((s) => s.byteRange)).toEqual([
      { start: 720, end: 100_719 },
      // No offset: continues from the previous range's end.
      { start: 100_720, end: 190_719 },
      { start: 300_000, end: 349_999 },
    ]);
  });
});

describe('discontinuities', () => {
  it('the segment after EXT-X-DISCONTINUITY carries the flag', () => {
    const result = parseMediaPlaylist(fixture('edge-discontinuity.m3u8'), BASE);
    expect(result.playlist?.segments.map((s) => s.discontinuity === true)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(result.playlist?.segments[2]?.start).toBe(8);
  });
});

describe('the coupling table', () => {
  it('multi-audio-group variants map each rendition to its group', () => {
    const result = parse(fixture('edge-multi-audio-groups.m3u8'), BASE);
    expect(result.presentation?.couplings).toEqual([
      { renditionId: 'v-800000', requires: { audio: 'aac-lo' } },
      { renditionId: 'v-2500000', requires: { audio: 'aac-hi' } },
      { renditionId: 'v-5000000', requires: { audio: 'aac-hi' } },
    ]);
    const audioTracks = result.presentation?.periods[0]?.tracks.filter(
      (t) => t.contentType === 'audio',
    );
    expect(audioTracks?.map((t) => t.id)).toEqual(['aac-lo:Stereo', 'aac-hi:Surround']);
  });

  it('a real SRG SSR master couples audio and subtitles per variant', () => {
    const result = parse(fixture('srgssr-rts-vod-master.m3u8'), BASE);
    expect(result.error).toBeNull();
    const coupling = result.presentation?.couplings[0];
    expect(coupling?.requires).toEqual({ audio: 'audio0', text: 'subs0' });
    const kinds = result.presentation?.periods[0]?.tracks.map((t) => t.contentType);
    expect(kinds).toContain('video');
    expect(kinds).toContain('audio');
    expect(kinds).toContain('text');
  });
});

describe('protection descriptors, before any DRM stage exists', () => {
  it('EXT-X-KEY METHOD=AES-128 keys the segments that follow, and is not DRM', () => {
    const result = parseMediaPlaylist(fixture('srgssr-rsi-style-media.m3u8'), BASE);
    // Full-segment encryption is a decrypt transform's job, never EME's.
    expect(result.playlist?.protection).toBeNull();
    for (const segment of result.playlist?.segments ?? []) {
      expect(segment.key).toEqual({
        method: 'AES-128',
        uri: 'https://keys.rsi.ch/key?id=abc,def',
        iv: '00000000000000000000000000000001',
      });
    }
  });

  it('a key line applies until the next one; NONE ends it; no IV means the sequence number', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:7',
      '#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"',
      '#EXTINF:10,',
      'a.ts',
      '#EXTINF:10,',
      'b.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="k2.bin",IV=0x1F',
      '#EXTINF:10,',
      'c.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:10,',
      'd.ts',
    ].join('\n');
    const segments = parseMediaPlaylist(text, 'https://cdn.example/p/x.m3u8').playlist?.segments;
    expect(segments?.map((s) => s.key)).toEqual([
      { method: 'AES-128', uri: 'https://cdn.example/p/k1.bin' },
      { method: 'AES-128', uri: 'https://cdn.example/p/k1.bin' },
      {
        method: 'AES-128',
        uri: 'https://cdn.example/p/k2.bin',
        iv: '0000000000000000000000000000001f',
      },
      undefined,
    ]);
  });

  it('EXT-X-SESSION-KEY protects the tracks of a multivariant playlist', () => {
    const result = parse(fixture('edge-session-key.m3u8'), BASE);
    const video = result.presentation?.periods[0]?.tracks[0];
    expect(video?.protection?.schemes[0]).toMatchObject({
      scheme: 'sample-aes',
      licenseUrl: 'skd://key42',
      systemId: 'com.apple.streamingkeydelivery',
    });
  });
});

describe('malformed manifests fail with values, never throws', () => {
  for (const name of [
    'malformed-no-extm3u.m3u8',
    'malformed-uri-without-extinf.m3u8',
    'malformed-empty-master.m3u8',
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
  it('every URL in the IR is absolute', () => {
    const result = parse(fixture('srgssr-rts-vod-master.m3u8'), BASE);
    for (const period of result.presentation?.periods ?? []) {
      for (const track of period.tracks) {
        for (const rendition of track.renditions) {
          expect(rendition.playlistUrl).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it('merging a media playlist fills segments, init, duration, and liveness', () => {
    const master = parse(fixture('srgssr-srf-style-master.m3u8'), BASE);
    const media = parseMediaPlaylist(
      fixture('srgssr-rsi-style-media.m3u8'),
      'https://cdn.example/path/index-f1-v1.m3u8',
    );
    const presentation = master.presentation;
    const playlist = media.playlist;
    if (presentation === null || playlist === null) throw new Error('fixture failure');

    const merged = mergePlaylist(presentation, 'v-1328485', playlist);
    expect(merged.isLive).toBe(false);
    expect(merged.duration).toBeCloseTo(16.52);
    const rendition = merged.periods[0]?.tracks[0]?.renditions.find((r) => r.id === 'v-1328485');
    expect(Array.isArray(rendition?.segments) && rendition.segments.length).toBe(3);
    expect(rendition?.init?.url).toBe('https://cdn.example/path/init.mp4');
    expect(rendition?.segments).toMatchSnapshot();
    // The original presentation is untouched.
    const original = presentation.periods[0]?.tracks[0]?.renditions.find(
      (r) => r.id === 'v-1328485',
    );
    expect(Array.isArray(original?.segments) && original.segments.length).toBe(0);
  });
});

describe('live: a sliding window keeps one absolute timeline across reloads', () => {
  function window(firstSeq: number, count: number, dur = 10) {
    const segments = Array.from({ length: count }, (_, i) => ({
      seq: firstSeq + i,
      start: i * dur,
      duration: dur,
      url: `https://cdn.example/seg-${firstSeq + i}.ts`,
    }));
    return {
      segments,
      init: null,
      targetDuration: dur,
      mediaSequence: firstSeq,
      endlist: false,
      playlistType: null,
      protection: null,
    };
  }
  const base = {
    id: 'x',
    isLive: true,
    periods: [
      {
        id: 'p0',
        start: 0,
        tracks: [
          {
            id: 'video-main',
            contentType: 'video' as const,
            mimeType: 'video/mp4',
            protection: null,
            renditions: [
              { id: 'v', bitrate: 1, codecs: 'avc1.42c00d', mimeType: 'video/mp4', segments: [] },
            ],
          },
        ],
      },
    ],
    couplings: [],
  };

  function startOf(p: ReturnType<typeof mergePlaylist>, seq: number): number | undefined {
    const segs = p.periods[0]?.tracks[0]?.renditions[0]?.segments;
    if (!Array.isArray(segs)) return undefined;
    return segs.find((s) => s.seq === seq)?.start;
  }

  it('rebases each refreshed window so a shared segment keeps its start and the edge advances', () => {
    const w1 = mergePlaylist(
      base as unknown as Parameters<typeof mergePlaylist>[0],
      'v',
      window(100, 5),
    );
    // First window is 0-based: seq100 at 0 ... seq104 at 40.
    expect(startOf(w1, 100)).toBe(0);
    expect(startOf(w1, 104)).toBe(40);

    // The window slides by one segment. A naive re-parse would put seq101 back
    // at 0 and cap the newest segment's start at 40 again, so the buffer could
    // never advance past 40 and playback would stall.
    const w2 = mergePlaylist(w1, 'v', window(101, 5));
    expect(startOf(w2, 101)).toBe(10); // shared seq keeps its absolute start
    expect(startOf(w2, 105)).toBe(50); // the live edge advances past the old max

    // A third slide keeps advancing on the same timeline.
    const w3 = mergePlaylist(w2, 'v', window(102, 5));
    expect(startOf(w3, 102)).toBe(20);
    expect(startOf(w3, 106)).toBe(60);
  });
});

describe('legacy AVC codec normalization', () => {
  it('rewrites the decimal avc1 form to hex so Chrome accepts it', () => {
    expect(normalizeAvcCodec('avc1.66.30')).toBe('avc1.42001e');
    expect(normalizeAvcCodec('avc1.77.31')).toBe('avc1.4d001f');
    expect(normalizeAvcCodec('avc1.100.40')).toBe('avc1.640028');
  });
  it('leaves an already-hex codec and non-AVC codecs untouched', () => {
    expect(normalizeAvcCodec('avc1.4d4015')).toBe('avc1.4d4015');
    expect(normalizeAvcCodec('mp4a.40.2')).toBe('mp4a.40.2');
    expect(normalizeAvcCodec('hvc1.1.6.L93.B0')).toBe('hvc1.1.6.L93.B0');
  });
});
