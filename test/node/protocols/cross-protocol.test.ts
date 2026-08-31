// @vitest-environment jsdom
// The Stage 10 proof at the IR level: an HLS packaging and a DASH
// packaging of the same CMAF encode parse to equivalent presentations,
// modulo IDs and the coupling table. The fixtures come straight from the
// E2E generator, one ffmpeg encode packaged twice.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { segmentAt } from '../../../src/kernel/timeline.js';
import { parse as parseMpd } from '../../../src/protocols/dash-cmaf/parse.js';
import {
  mergePlaylist,
  parse as parseM3u8,
  parseMediaPlaylist,
} from '../../../src/protocols/hls-cmaf/parse.js';
import type { Presentation, Rendition, Segment } from '../../../src/types/ir.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/manifests');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function hlsPresentation(): Presentation {
  const base = 'https://cdn.example/hls/master.m3u8';
  const master = parseM3u8(fixture('equiv-local-h264-master.m3u8'), base);
  let presentation = master.presentation;
  if (presentation === null) throw new Error('master failed to parse');
  for (const [renditionId, file] of [
    ['v-150000', 'equiv-local-h264-low.m3u8'],
    ['v-300000', 'equiv-local-h264-high.m3u8'],
  ] as const) {
    const media = parseMediaPlaylist(fixture(file), `https://cdn.example/hls/${file}`);
    if (media.playlist === null) throw new Error(`${file} failed to parse`);
    presentation = mergePlaylist(presentation, renditionId, media.playlist);
  }
  return presentation;
}

function dashPresentation(): Presentation {
  const result = parseMpd(fixture('equiv-local-h264.mpd'), 'https://cdn.example/dash/manifest.mpd');
  if (result.presentation === null) throw new Error('MPD failed to parse');
  return result.presentation;
}

function materialize(rendition: Rendition): readonly Segment[] {
  const addressing = rendition.segments;
  if (!('kind' in addressing)) return addressing;
  if (addressing.kind !== 'indexed') return [];
  if (addressing.endSeq === null) throw new Error('unbounded addressing');
  const out: Segment[] = [];
  for (let seq = addressing.startSeq; seq <= addressing.endSeq; seq += 1) {
    const segment = segmentAt(addressing, seq);
    if (segment !== null) out.push(segment);
  }
  return out;
}

function byBitrate(presentation: Presentation): readonly Rendition[] {
  const track = presentation.periods[0]?.tracks.find((t) => t.contentType === 'video');
  return [...(track?.renditions ?? [])].sort((a, b) => a.bitrate - b.bitrate);
}

describe('the IRs converge', () => {
  const hls = hlsPresentation();
  const dash = dashPresentation();

  it('same liveness and duration', () => {
    expect(hls.isLive).toBe(false);
    expect(dash.isLive).toBe(false);
    expect(Math.abs((hls.duration ?? 0) - (dash.duration ?? 0))).toBeLessThan(0.5);
  });

  it('same track shape: one video track, no couplings on either side beyond identity', () => {
    expect(hls.periods).toHaveLength(1);
    expect(dash.periods).toHaveLength(1);
    const hlsKinds = hls.periods[0]?.tracks.map((t) => t.contentType);
    const dashKinds = dash.periods[0]?.tracks.map((t) => t.contentType);
    expect(hlsKinds).toEqual(dashKinds);
    // Video-only content: HLS has nothing to couple, DASH never does.
    expect(hls.couplings).toEqual([]);
    expect(dash.couplings).toEqual([]);
  });

  it('same renditions: bitrates, resolutions, codecs', () => {
    const hlsRenditions = byBitrate(hls);
    const dashRenditions = byBitrate(dash);
    expect(hlsRenditions.map((r) => r.bitrate)).toEqual(dashRenditions.map((r) => r.bitrate));
    expect(hlsRenditions.map((r) => [r.width, r.height])).toEqual(
      dashRenditions.map((r) => [r.width, r.height]),
    );
    expect(hlsRenditions.map((r) => r.codecs)).toEqual(dashRenditions.map((r) => r.codecs));
    expect(hlsRenditions.map((r) => r.mimeType)).toEqual(dashRenditions.map((r) => r.mimeType));
  });

  it('same segment timing, segment by segment', () => {
    for (const [hlsRendition, dashRendition] of [
      [byBitrate(hls)[0], byBitrate(dash)[0]],
      [byBitrate(hls)[1], byBitrate(dash)[1]],
    ] as const) {
      const a = materialize(hlsRendition as Rendition);
      const b = materialize(dashRendition as Rendition);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i += 1) {
        const left = a[i] as Segment;
        const right = b[i] as Segment;
        expect(Math.abs(left.start - right.start)).toBeLessThan(0.1);
        expect(Math.abs(left.duration - right.duration)).toBeLessThan(0.1);
      }
    }
  });

  it('both sides carry an init segment reference', () => {
    for (const rendition of [...byBitrate(hls), ...byBitrate(dash)]) {
      expect(rendition.init?.url).toMatch(/^https:\/\//);
    }
  });
});
