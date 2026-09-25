// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { applyRefresh } from '../../../src/kernel/refresh.js';
import dashCmaf from '../../../src/protocols/dash-cmaf/index.js';
import { parse as parseMpd } from '../../../src/protocols/dash-cmaf/parse.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import {
  parse as parseM3u8,
  parseMediaPlaylist,
  refreshFor,
} from '../../../src/protocols/hls-cmaf/parse.js';
import type { Thumbnail, ThumbnailsApi } from '../../../src/stages/thumbnails/index.js';
import thumbnails, { parseThumbnailTrack } from '../../../src/stages/thumbnails/index.js';
import type { Presentation, Rendition, Track } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { Stage, StageContext } from '../../../src/types/stage.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/manifests');
const HLS_BASE = 'https://cdn.example/hls/master.m3u8';
const DASH_BASE = 'https://cdn.example/dash/manifest.mpd';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function imageTrack(presentation: Presentation | null): Track {
  const track = presentation?.periods[0]?.tracks.find((t) => t.contentType === 'image');
  if (track === undefined) throw new Error('no image track');
  return track;
}

function hlsWithImages(): Presentation {
  const master = parseM3u8(fixture('edge-image-stream-master.m3u8'), HLS_BASE).presentation;
  if (master === null) throw new Error('master failed to parse');
  const url = 'https://cdn.example/hls/images/320x180-5x2.m3u8';
  const media = parseMediaPlaylist(fixture('edge-image-stream-media.m3u8'), url).playlist;
  if (media === null) throw new Error('image playlist failed to parse');
  const refresh = refreshFor(master, 'i-320x180', media);
  if (refresh === null) throw new Error('no refresh');
  return applyRefresh(master, refresh) ?? master;
}

function dashWithImages(name: string): Presentation {
  const presentation = parseMpd(fixture(name), DASH_BASE).presentation;
  if (presentation === null) throw new Error(`${name} failed to parse`);
  return presentation;
}

describe('HLS image playlists', () => {
  it('each EXT-X-IMAGE-STREAM-INF is a rendition of one image track', () => {
    const track = imageTrack(
      parseM3u8(fixture('edge-image-stream-master.m3u8'), HLS_BASE).presentation,
    );
    expect(track).toMatchObject({ id: 'image-main', contentType: 'image', mimeType: 'image/jpeg' });
    expect(track.renditions.map((r) => r.id)).toEqual(['i-320x180', 'i-160x90']);
    expect(track.renditions[0]).toMatchObject({
      bitrate: 16460,
      width: 320,
      height: 180,
      codecs: 'jpeg',
      playlistUrl: 'https://cdn.example/hls/images/320x180-5x2.m3u8',
    });
  });

  it('LAYOUT on the stream tag gives the grid before the playlist loads', () => {
    const track = imageTrack(
      parseM3u8(fixture('edge-image-stream-master.m3u8'), HLS_BASE).presentation,
    );
    expect(track.renditions[0]?.tiles).toBeUndefined();
    expect(track.renditions[1]?.tiles).toEqual({ columns: 5, rows: 2, width: 160, height: 90 });
  });

  it('EXT-X-TILES gives the grid and the tile duration', () => {
    const media = parseMediaPlaylist(
      fixture('edge-image-stream-media.m3u8'),
      'https://cdn.example/hls/images/320x180-5x2.m3u8',
    ).playlist;
    expect(media?.tiles).toEqual({ columns: 5, rows: 2, width: 320, height: 180, duration: 6 });
    expect(media?.segments.map((s) => s.url)).toEqual([
      'https://cdn.example/hls/images/tile-1.jpg',
      'https://cdn.example/hls/images/tile-2.jpg',
      'https://cdn.example/hls/images/tile-3.jpg',
    ]);
  });

  it('the merge carries the grid onto the rendition', () => {
    const rendition = imageTrack(hlsWithImages()).renditions[0] as Rendition;
    expect(rendition.tiles).toEqual({ columns: 5, rows: 2, width: 320, height: 180, duration: 6 });
    expect(rendition.segments).toHaveLength(3);
  });

  it('a multivariant playlist without images has no image track', () => {
    const presentation = parseM3u8(
      fixture('apple-bipbop-basic-master.m3u8'),
      HLS_BASE,
    ).presentation;
    expect(presentation?.periods[0]?.tracks.some((t) => t.contentType === 'image')).toBe(false);
  });
});

describe('DASH image AdaptationSets', () => {
  it('the thumbnail_tile property gives the grid, the tile size divided out', () => {
    const track = imageTrack(dashWithImages('dashif-bbb-tiled-thumbnails.mpd'));
    expect(track.mimeType).toBe('image/jpeg');
    expect(track.renditions[0]?.tiles).toEqual({ columns: 10, rows: 1, width: 320, height: 180 });
  });

  it('keeps a fractional tile width', () => {
    const track = imageTrack(dashWithImages('dashif-bbb-4-tiles-thumbnails.mpd'));
    expect(track.renditions[0]?.tiles).toEqual({
      columns: 10,
      rows: 1,
      width: 204.8,
      height: 115,
    });
  });

  it('an image set without the property has no grid', () => {
    const mpd = fixture('dashif-bbb-tiled-thumbnails.mpd').replace(
      /<EssentialProperty[^>]*thumbnail_tile[^>]*\/>/,
      '',
    );
    const track = imageTrack(parseMpd(mpd, DASH_BASE).presentation);
    expect(track.renditions[0]?.tiles).toBeUndefined();
  });
});

/** Installs stages into a pure reducer, the way the loader composes slices. */
function compose(...stages: Stage[]) {
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
  return createReducer(slices);
}

/** Loads a manifest and follows every zero-delay loop-back, collecting effects. */
function boot(
  reduce: ReturnType<typeof createReducer>,
  url: string,
  text: string,
): { state: KernelState; effects: Effect[] } {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url });
  [state] = reduce(state, { type: 'MEDIASOURCE_OPEN' });
  const token = [...state.scheduling.inflight.keys()][0] as string;
  const body = new TextEncoder().encode(text).buffer as ArrayBuffer;
  const first: Message = {
    type: 'SEGMENT_LOADED',
    trackId: 'manifest',
    seq: 0,
    token,
    bytes: body,
    rtt: 5,
    size: body.byteLength,
  };
  const all: Effect[] = [];
  let frontier: readonly Effect[];
  [state, frontier] = reduce(state, first);
  while (frontier.length > 0) {
    all.push(...frontier);
    const next: Effect[] = [];
    for (const effect of frontier) {
      if (effect.kind !== 'schedule' || effect.delayMs !== 0) continue;
      const [reduced, produced] = reduce(state, effect.then);
      state = reduced;
      next.push(...produced);
    }
    frontier = next;
  }
  return { state, effects: all };
}

function fetchUrls(effects: readonly Effect[]): string[] {
  return effects.flatMap((e) => (e.kind === 'fetch' ? [e.url] : []));
}

describe('the thumbnails stage selects the image track', () => {
  it('DASH: the image track is active and the kernel fetches no sprite sheet', () => {
    const reduce = compose(dashCmaf(), thumbnails());
    const { state, effects } = boot(reduce, DASH_BASE, fixture('dashif-bbb-tiled-thumbnails.mpd'));
    expect(state.tracks.active.get('image')).toBe('as-3');
    expect(fetchUrls(effects).filter((url) => url.endsWith('.jpg'))).toEqual([]);
  });

  it('DASH: the kernel schedules the same fetches with or without an image track', () => {
    const withImages = fixture('dashif-bbb-tiled-thumbnails.mpd');
    const without = withImages.replace(/<AdaptationSet id="3"[\s\S]*?<\/AdaptationSet>/, '');
    const reduce = compose(dashCmaf(), thumbnails());
    const a = boot(reduce, DASH_BASE, withImages);
    const b = boot(reduce, DASH_BASE, without);
    expect(fetchUrls(a.effects)).toEqual(fetchUrls(b.effects));
  });

  it('HLS: selecting the image track fetches its playlists', () => {
    const reduce = compose(hlsCmaf(), thumbnails());
    const { state, effects } = boot(reduce, HLS_BASE, fixture('edge-image-stream-master.m3u8'));
    expect(state.tracks.active.get('image')).toBe('image-main');
    expect(fetchUrls(effects).filter((url) => url.includes('/images/'))).toEqual([
      'https://cdn.example/hls/images/320x180-5x2.m3u8',
      'https://cdn.example/hls/images/160x90-5x2.m3u8',
    ]);
  });

  it('HLS: without the stage no image playlist is fetched', () => {
    const reduce = compose(hlsCmaf());
    const { state, effects } = boot(reduce, HLS_BASE, fixture('edge-image-stream-master.m3u8'));
    expect(state.tracks.active.has('image')).toBe(false);
    expect(fetchUrls(effects).filter((url) => url.includes('/images/'))).toEqual([]);
  });
});

/** Installs the stage against a state the test controls. */
function install(options: { state?: KernelState; responses?: Record<string, string> } = {}) {
  let state = options.state ?? initialState();
  let api: ThumbnailsApi | null = null;
  const requests: string[] = [];
  const ctx = {
    getState: () => state,
    reduce: () => undefined,
    registerNamespace: (_name: string, value: object) => {
      api = value as ThumbnailsApi;
    },
    request: async (url: string) => {
      requests.push(url);
      const body = options.responses?.[url];
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body, { status: 200 });
    },
  } as unknown as StageContext;
  const teardown = thumbnails().install(ctx);
  return {
    api: api as unknown as ThumbnailsApi,
    requests,
    teardown: teardown as () => void,
    setState(next: KernelState) {
      state = next;
    },
  };
}

function withPresentation(presentation: Presentation, activeImage?: string): KernelState {
  const state = initialState();
  const active = new Map(state.tracks.active);
  if (activeImage !== undefined) active.set('image', activeImage);
  return { ...state, presentation, tracks: { ...state.tracks, active } };
}

describe('manifest tiles', () => {
  it('DASH spreads the grid over each segment', () => {
    const { api } = install({
      state: withPresentation(dashWithImages('dashif-bbb-tiled-thumbnails.mpd')),
    });
    expect(api.source).toBe('manifest');
    expect(api.at(25)).toEqual({
      url: 'https://cdn.example/dash/thumbnails_320x180/tile_1.jpg',
      start: 20,
      end: 30,
      x: 640,
      y: 0,
      width: 320,
      height: 180,
    });
    expect(api.at(105)).toMatchObject({ url: expect.stringContaining('tile_2.jpg'), x: 0 });
  });

  it('DASH lists every tile of a finite presentation', () => {
    const { api } = install({
      state: withPresentation(dashWithImages('dashif-bbb-4-tiles-thumbnails.mpd')),
    });
    expect(api.all).toHaveLength(40);
    expect(api.all[11]).toMatchObject({ x: 204.8, url: expect.stringContaining('tile_2.jpg') });
  });

  it('HLS uses the tile duration, so a short last sheet stays right', () => {
    const { api } = install({ state: withPresentation(hlsWithImages()) });
    expect(api.at(13)).toMatchObject({ start: 12, end: 18, x: 640, y: 0 });
    expect(api.at(40)).toMatchObject({ x: 320, y: 180 });
    // The last sheet covers 18 s: three tiles of 6 s, not the grid's ten.
    expect(api.at(131)).toMatchObject({ start: 126, end: 132, x: 320 });
    expect(api.at(138)).toBeNull();
    expect(api.all).toHaveLength(23);
  });

  it('prefers the active image track', () => {
    const presentation = hlsWithImages();
    const period = presentation.periods[0];
    if (period === undefined) throw new Error('no period');
    const first = imageTrack(presentation);
    const second: Track = {
      ...first,
      id: 'image-alt',
      renditions: first.renditions.map((r) => ({
        ...r,
        id: `alt-${r.id}`,
        segments: Array.isArray(r.segments)
          ? r.segments.map((s) => ({ ...s, url: s.url.replace('tile-', 'alt-') }))
          : r.segments,
      })),
    };
    const doubled = {
      ...presentation,
      periods: [{ ...period, tracks: [...period.tracks, second] }],
    };
    const { api, setState } = install({ state: withPresentation(doubled) });
    expect(api.at(1)?.url).toContain('/tile-1.jpg');
    setState(withPresentation(doubled, 'image-alt'));
    expect(api.at(1)?.url).toContain('/alt-1.jpg');
  });

  it('DASH live: an open template answers at(time) and lists nothing', () => {
    const { api } = install({
      state: withPresentation(dashWithImages('dashif-livesim-thumbnails.mpd')),
    });
    // 1x1 tiles of 2 s from number 0 at time 0.
    expect(api.at(101)).toMatchObject({
      url: 'https://cdn.example/dash/thumbs/50.jpg',
      start: 100,
      end: 102,
      x: 0,
      y: 0,
      width: 160,
      height: 90,
    });
    expect(api.all).toEqual([]);
  });

  it('DASH: two image renditions in one set, the first with a grid wins', () => {
    const track = imageTrack(dashWithImages('dashif-bbb-multiple-tiled-thumbnails.mpd'));
    expect(track.renditions.map((r) => r.tiles)).toEqual([
      { columns: 10, rows: 20, width: 102.4, height: 57.6 },
      { columns: 8, rows: 8, width: 256, height: 144 },
    ]);
    const { api } = install({
      state: withPresentation(dashWithImages('dashif-bbb-multiple-tiled-thumbnails.mpd')),
    });
    expect(api.at(0)?.url).toContain('thumbnails_102x58');
  });

  it('answers none without an image track', () => {
    const { api } = install();
    expect(api.source).toBe('none');
    expect(api.at(1)).toBeNull();
    expect(api.all).toEqual([]);
  });
});

describe('WebVTT thumbnail tracks', () => {
  it('a cue id line is not taken for the image URL', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:05.000',
      'sprite.jpg#xywh=160,90,160,90',
    ].join('\n');
    const [tile] = parseThumbnailTrack(vtt, 'https://cdn.example/thumbs/track.vtt');
    expect(tile).toEqual({
      url: 'https://cdn.example/thumbs/sprite.jpg',
      start: 0,
      end: 5,
      x: 160,
      y: 90,
      width: 160,
      height: 90,
    });
  });
});

describe('app-loaded WebVTT tiles', () => {
  const VTT = ['WEBVTT', '', '00:00:00.000 --> 00:00:10.000', 'sprite.jpg#xywh=0,0,160,90'].join(
    '\n',
  );

  it('win over the manifest once loaded', async () => {
    const { api } = install({
      state: withPresentation(dashWithImages('dashif-bbb-tiled-thumbnails.mpd')),
      responses: { 'https://cdn.example/thumbs.vtt': VTT },
    });
    expect(await api.load('https://cdn.example/thumbs.vtt')).toBe(1);
    expect(api.source).toBe('app');
    expect(api.at(5)?.url).toBe('https://cdn.example/sprite.jpg');
    expect(api.all).toHaveLength(1);
  });
});

describe('an app track after the next source loads', () => {
  it('no longer applies', async () => {
    const VTT = ['WEBVTT', '', '00:00:00.000 --> 00:00:10.000', 'sprite.jpg#xywh=0,0,160,90'].join(
      '\n',
    );
    const { api, setState } = install({ responses: { 'https://cdn.example/thumbs.vtt': VTT } });
    await api.load('https://cdn.example/thumbs.vtt');
    expect(api.source).toBe('app');
    // The stage's slice counts LOAD, UNLOAD, and DETACH.
    setState({ ...initialState(), thumbnails: { loads: 1 } });
    expect(api.source).toBe('none');
    expect(api.at(5)).toBeNull();
  });
});

describe('a failed track load', () => {
  it('rejects instead of loading no tiles', async () => {
    const { api } = install();
    await expect(api.load('https://cdn.example/missing.vtt')).rejects.toThrow('HTTP 404');
    expect(api.source).toBe('none');
  });
});

describe('sprite images', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function tile(url: string): Thumbnail {
    return { url, start: 0, end: 1, x: 0, y: 0, width: 1, height: 1 };
  }

  it('fetch once through the transport and come back as object URLs', async () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      n += 1;
      return `blob:${n}`;
    });
    const { api, requests } = install({ responses: { 'https://cdn.example/a.jpg': 'jpeg' } });
    const first = await api.image(tile('https://cdn.example/a.jpg'));
    const second = await api.image(tile('https://cdn.example/a.jpg'));
    expect(first).toBe('blob:1');
    expect(second).toBe('blob:1');
    expect(requests).toEqual(['https://cdn.example/a.jpg']);
  });

  it('a failed fetch rejects and is retried on the next call', async () => {
    const { api, requests } = install();
    await expect(api.image(tile('https://cdn.example/gone.jpg'))).rejects.toThrow('HTTP 404');
    await expect(api.image(tile('https://cdn.example/gone.jpg'))).rejects.toThrow('HTTP 404');
    expect(requests).toHaveLength(2);
  });

  it('evicts the least recent sheet past the cache size and revokes on detach', async () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      n += 1;
      return `blob:${n}`;
    });
    const revoked: string[] = [];
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url);
    });
    const responses: Record<string, string> = {};
    for (let i = 0; i < 17; i += 1) responses[`https://cdn.example/${i}.jpg`] = 'jpeg';
    const { api, teardown } = install({ responses });
    for (let i = 0; i < 17; i += 1) await api.image(tile(`https://cdn.example/${i}.jpg`));
    await Promise.resolve();
    expect(revoked).toEqual(['blob:1']);
    teardown();
    await Promise.resolve();
    expect(revoked).toHaveLength(17);
  });
});
