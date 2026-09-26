// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import dashCmaf from '../../../src/protocols/dash-cmaf/index.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import { parse, parseMediaPlaylist } from '../../../src/protocols/hls-cmaf/parse.js';
import abr from '../../../src/stages/abr/index.js';
import type { Presentation, Track } from '../../../src/types/ir.js';
import type { SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { Stage } from '../../../src/types/stage.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/manifests');
const HLS_BASE = 'https://cdn.example/hls/master.m3u8';
const DASH_BASE = 'https://cdn.example/dash/manifest.mpd';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function trickOf(presentation: Presentation | null): Track {
  const track = presentation?.periods[0]?.tracks.find((t) => t.role === 'trick');
  if (track === undefined) throw new Error('no trick track');
  return track;
}

describe('HLS I-frame playlists', () => {
  it('each EXT-X-I-FRAME-STREAM-INF is a rendition of one trick track', () => {
    const presentation = parse(fixture('apple-advanced-fmp4-master.m3u8'), HLS_BASE).presentation;
    const trick = trickOf(presentation);
    expect(trick).toMatchObject({ id: 'video-trick', contentType: 'video', role: 'trick' });
    expect(trick.renditions[0]).toMatchObject({
      id: 't-1920x1080',
      bitrate: 187492,
      codecs: 'avc1.64002a',
      width: 1920,
      height: 1080,
      playlistUrl: 'https://cdn.example/hls/v7/iframe_index.m3u8',
    });
    // The playable ladder is unchanged.
    const main = presentation?.periods[0]?.tracks.find((t) => t.id === 'video-main');
    expect(main?.renditions.some((r) => r.id.startsWith('t-'))).toBe(false);
  });

  it('an I-frame media playlist addresses byte ranges inside the normal segments', () => {
    const url = 'https://cdn.example/hls/v3/iframe_index.m3u8';
    const playlist = parseMediaPlaylist(
      fixture('apple-advanced-fmp4-iframe-media.m3u8'),
      url,
    ).playlist;
    expect(playlist?.init).toEqual({
      url: 'https://cdn.example/hls/v3/main.mp4',
      byteRange: { start: 0, end: 719 },
    });
    expect(playlist?.segments).toHaveLength(5);
    expect(playlist?.segments[1]).toMatchObject({
      start: 2,
      duration: 2,
      url: 'https://cdn.example/hls/v3/main.mp4',
      byteRange: { start: 169476, end: 169476 + 15118 - 1 },
    });
  });
});

/** A DASH MPD with a trick-mode set listed before the main video set, optionally. */
function mpd(withTrick: boolean): string {
  const trick = `
    <AdaptationSet id="9" mimeType="video/mp4">
      <EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="1"/>
      <Representation id="trick" width="320" height="180" bandwidth="15624" codecs="avc1.42C00D" maxPlayoutRate="50">
        <SegmentTemplate timescale="25000" media="t_$Number$.mp4" initialization="t_init.mp4" startNumber="1" duration="150000"/>
      </Representation>
    </AdaptationSet>`;
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT60S">
  <Period start="PT0S" id="1">${withTrick ? trick : ''}
    <AdaptationSet id="1" mimeType="video/mp4">
      <Representation id="main-lo" width="640" height="360" bandwidth="1000000" codecs="avc1.4D401F">
        <SegmentTemplate timescale="25000" media="lo_$Number$.mp4" initialization="lo_init.mp4" startNumber="1" duration="150000"/>
      </Representation>
      <Representation id="main-hi" width="1280" height="720" bandwidth="3000000" codecs="avc1.4D401F">
        <SegmentTemplate timescale="25000" media="hi_$Number$.mp4" initialization="hi_init.mp4" startNumber="1" duration="150000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

function compose(stages: readonly Stage[], hooks: Parameters<typeof createReducer>[2] = {}) {
  const slices: Array<readonly [string, SliceReducer]> = [];
  for (const stage of stages) {
    stage.install({
      element: {} as HTMLMediaElement,
      registerSink: () => undefined,
      registerParser: () => undefined,
      registerTransform: () => undefined,
      registerNamespace: () => undefined,
      registerChooser: () => undefined,
      registerSwitchPolicy: () => undefined,
      registerTypeProbe: () => undefined,
      registerTimeProbe: () => undefined,
      getState: () => initialState(),
      addRequestHook: () => () => undefined,
      request: async () => new Response(),
      reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
      dispatch: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
    });
  }
  return createReducer(slices, {}, hooks);
}

/** Loads a manifest and follows every zero-delay loop-back, collecting effects. */
function boot(reduce: ReturnType<typeof createReducer>, url: string, text: string) {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url });
  [state] = reduce(state, { type: 'MEDIASOURCE_OPEN' });
  const token = [...state.scheduling.inflight.keys()][0] as string;
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
  const first: Message = {
    type: 'SEGMENT_LOADED',
    trackId: 'manifest',
    seq: 0,
    token,
    bytes,
    rtt: 5,
    size: 1,
  };
  const effects: Effect[] = [];
  let frontier: readonly Effect[];
  [state, frontier] = reduce(state, first);
  while (frontier.length > 0) {
    effects.push(...frontier);
    const next: Effect[] = [];
    for (const effect of frontier) {
      if (effect.kind !== 'schedule' || effect.delayMs !== 0) continue;
      const [reduced, produced] = reduce(state, effect.then);
      state = reduced;
      next.push(...produced);
    }
    frontier = next;
  }
  return { state, effects };
}

function fetchUrls(effects: readonly Effect[]): string[] {
  return effects.flatMap((e) => (e.kind === 'fetch' ? [e.url] : []));
}

describe('normal playback ignores the trick track', () => {
  it('DASH: the main set is selected even when the trick set comes first', () => {
    const { state } = boot(compose([dashCmaf()]), DASH_BASE, mpd(true));
    expect(state.tracks.active.get('video')).toBe('as-1');
  });

  it('DASH: the kernel schedules the same fetches with or without a trick set', () => {
    const reduce = compose([dashCmaf()]);
    const a = boot(reduce, DASH_BASE, mpd(true));
    const b = boot(reduce, DASH_BASE, mpd(false));
    expect(fetchUrls(a.effects)).toEqual(fetchUrls(b.effects));
  });

  it('HLS: no I-frame playlist is fetched', () => {
    const { state, effects } = boot(
      compose([hlsCmaf()]),
      HLS_BASE,
      fixture('apple-advanced-fmp4-master.m3u8'),
    );
    expect(state.tracks.active.get('video')).toBe('video-main');
    expect(fetchUrls(effects).filter((url) => url.includes('iframe'))).toEqual([]);
  });

  it('a stage may select the trick track, and back', () => {
    const reduce = compose([dashCmaf()]);
    const { state } = boot(reduce, DASH_BASE, mpd(true));
    const [trick] = reduce(state, { type: 'SELECT_TRACK', trackId: 'as-9' });
    expect(trick.tracks.active.get('video')).toBe('as-9');
    const [back] = reduce(trick, { type: 'SELECT_TRACK', trackId: 'as-1' });
    expect(back.tracks.active.get('video')).toBe('as-1');
  });

  it('a decodable trick track does not stand in for an undecodable stream', () => {
    const decodable = (type: string) => type.includes('42C00D');
    const reduce = compose([dashCmaf()], { decodable });
    const { state } = boot(reduce, DASH_BASE, mpd(true));
    expect(state.lifecycle.phase).toBe('error');
  });

  it('abr reads the lowest bitrate from the playable ladder only', () => {
    const reduce = compose([dashCmaf(), abr()]);
    const a = boot(reduce, DASH_BASE, mpd(true));
    const b = boot(reduce, DASH_BASE, mpd(false));
    expect(a.state.quality.active).toBe(b.state.quality.active);
    expect(fetchUrls(a.effects)).toEqual(fetchUrls(b.effects));
  });
});
