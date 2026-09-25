/**
 * Thumbnails: the trick-play images a scrubbing UI shows, answered through
 * `engine.thumbnails`. Two sources fill it:
 *
 * - The manifest. An image track (HLS EXT-X-IMAGE-STREAM-INF, a DASH image
 *   AdaptationSet with the DASH-IF thumbnail_tile property) whose segments
 *   are sprite sheets split by the rendition's tile grid. Tiles derive from
 *   the presentation the kernel holds, so live updates need no copy here.
 * - A WebVTT track the app loads, whose cues point at sprite tiles with an
 *   #xywh media fragment. It wins over the manifest once loaded.
 *
 * The kernel never schedules an image track. On MANIFEST_LOADED this stage
 * selects the first image track, which is what makes hls-cmaf fetch its
 * media playlist; images load only when the app asks through `image()`,
 * through the transport seam, so request hooks (auth, cmcd, steering) apply.
 */

import { parseVtt } from '../../containers/webvtt.js';
import { scheduled } from '../../kernel/effects.js';
import { isIndexed, segmentAt, segmentAtTime } from '../../kernel/timeline.js';
import type { Period, Rendition, Segment, Track } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Stage } from '../../types/stage.js';

/** One thumbnail: the tile's image URL and its rectangle within the sprite. */
export interface Thumbnail {
  readonly url: string;
  readonly start: number;
  readonly end: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Sprite sheets kept as object URLs; each holds tens of tiles. */
const IMAGE_CACHE_SIZE = 16;

/** Parses a WebVTT thumbnail track into tiles, resolving URLs against a base. */
export function parseThumbnailTrack(text: string, baseUrl: string): Thumbnail[] {
  const thumbnails: Thumbnail[] = [];
  for (const cue of parseVtt(text).cues) {
    // The cue text is the image URL, with an #xywh media fragment for a sprite tile.
    const [rawUrl, fragment] = (cue.text ?? '').trim().split('#');
    if (rawUrl === undefined || rawUrl === '') continue;
    const xywh = /xywh=(?:pixel:)?(\d+),(\d+),(\d+),(\d+)/.exec(fragment ?? '');
    thumbnails.push({
      url: new URL(rawUrl, baseUrl).href,
      start: cue.start,
      end: cue.end,
      x: Number(xywh?.[1] ?? 0),
      y: Number(xywh?.[2] ?? 0),
      width: Number(xywh?.[3] ?? 0),
      height: Number(xywh?.[4] ?? 0),
    });
  }
  return thumbnails;
}

interface ImageSource {
  readonly period: Period;
  readonly rendition: Rendition & { readonly tiles: NonNullable<Rendition['tiles']> };
}

/**
 * The image rendition tiles come from: the active image track, else the
 * first image track, and in it the first rendition with a grid and known
 * segments. Null when the presentation has none.
 */
export function imageSource(state: Readonly<KernelState>): ImageSource | null {
  const presentation = state.presentation;
  if (presentation === null) return null;
  const activeId = state.tracks.active.get('image');
  const candidates: Array<{ period: Period; track: Track }> = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (track.contentType !== 'image') continue;
      if (track.id === activeId) candidates.unshift({ period, track });
      else candidates.push({ period, track });
    }
  }
  for (const { period, track } of candidates) {
    for (const rendition of track.renditions) {
      if (rendition.tiles === undefined) continue;
      if (Array.isArray(rendition.segments) && rendition.segments.length === 0) continue;
      return { period, rendition: rendition as ImageSource['rendition'] };
    }
  }
  return null;
}

/**
 * Seconds each tile of a sheet covers. HLS gives it (EXT-X-TILES DURATION),
 * so a last sheet with fewer tiles than the grid stays right; DASH spreads
 * the grid evenly over the segment.
 */
function tileDuration(source: ImageSource, segment: Segment): number {
  const grid = source.rendition.tiles;
  return grid.duration ?? segment.duration / (grid.columns * grid.rows);
}

/** How many tiles of the grid a sheet uses. */
function tileCount(source: ImageSource, segment: Segment): number {
  const grid = source.rendition.tiles;
  const used = Math.ceil(segment.duration / tileDuration(source, segment) - 1e-9);
  return Math.max(1, Math.min(grid.columns * grid.rows, used));
}

/** Tile `index` of one sprite-sheet segment. */
function tileOf(source: ImageSource, segment: Segment, index: number): Thumbnail {
  const grid = source.rendition.tiles;
  const duration = tileDuration(source, segment);
  const start = segment.start + index * duration;
  return {
    url: segment.url,
    start,
    end: Math.min(start + duration, segment.start + segment.duration),
    x: (index % grid.columns) * grid.width,
    y: Math.floor(index / grid.columns) * grid.height,
    width: grid.width,
    height: grid.height,
  };
}

/** The tile of one sprite-sheet segment covering `time`, or null outside it. */
function tileIn(source: ImageSource, segment: Segment, time: number): Thumbnail | null {
  if (time < segment.start || time >= segment.start + segment.duration) return null;
  const index = Math.floor((time - segment.start) / tileDuration(source, segment));
  return tileOf(source, segment, Math.min(tileCount(source, segment) - 1, index));
}

/** Every tile of the source, when its segment list is finite. An open live template yields none. */
function allTiles(source: ImageSource): Thumbnail[] {
  const addressing = source.rendition.segments;
  const segments: Segment[] = [];
  if (Array.isArray(addressing)) {
    segments.push(...(addressing as readonly Segment[]));
  } else if (isIndexed(addressing)) {
    if (addressing.endSeq === null) return [];
    for (let seq = addressing.startSeq; seq <= addressing.endSeq; seq += 1) {
      const segment = segmentAt(addressing, seq, source.period.start);
      if (segment !== null) segments.push(segment);
    }
  }
  const out: Thumbnail[] = [];
  for (const segment of segments) {
    const count = tileCount(source, segment);
    for (let index = 0; index < count; index += 1) out.push(tileOf(source, segment, index));
  }
  return out;
}

/**
 * Selects the first image track when a manifest loads and none is active.
 * Pure: the command loops back through a zero-delay schedule effect.
 */
const reduceThumbnails: SliceReducer<null> = (_slice, msg, kernel) => {
  if (msg.type !== 'MANIFEST_LOADED' || kernel.tracks.active.has('image')) return [null, []];
  for (const period of msg.presentation.periods) {
    const track = period.tracks.find((t) => t.contentType === 'image');
    if (track === undefined) continue;
    return [null, [scheduled('thumbnails:select', { type: 'SELECT_TRACK', trackId: track.id })]];
  }
  return [null, []];
};

export interface ThumbnailsApi {
  /** Fetches and parses a WebVTT thumbnail track at a URL. It wins over the manifest's tiles. */
  load(url: string): Promise<number>;
  /** The tile covering a presentation time, or null. */
  at(time: number): Thumbnail | null;
  /**
   * The tile's sprite sheet as an object URL, fetched through the transport
   * so request hooks apply. The last few sheets stay cached; the stage
   * revokes the URLs it evicts and all of them on detach.
   */
  image(tile: Thumbnail): Promise<string>;
  /** Every tile, in order. Empty for an open-ended live template. */
  readonly all: readonly Thumbnail[];
  /** Where the tiles come from. */
  readonly source: 'none' | 'app' | 'manifest';
}

export default function thumbnails(): Stage {
  return {
    name: 'thumbnails',
    provides: ['thumbnails'],
    requires: ['transport'],
    install(ctx) {
      ctx.reduce('thumbnails', reduceThumbnails as SliceReducer);
      let tiles: Thumbnail[] | null = null;
      // Insertion order is recency: a hit moves to the end, eviction takes the front.
      const images = new Map<string, Promise<string>>();

      async function fetchImage(url: string): Promise<string> {
        const response = await ctx.request(url, { method: 'GET' });
        if (!response.ok) throw new TypeError(`thumbnail image ${url}: HTTP ${response.status}`);
        return URL.createObjectURL(await response.blob());
      }

      function revoke(pending: Promise<string>): void {
        pending.then(
          (url) => URL.revokeObjectURL(url),
          () => undefined,
        );
      }

      const api: ThumbnailsApi = {
        async load(url: string): Promise<number> {
          const response = await ctx.request(url, { method: 'GET' });
          // An error page would parse as a track with no tiles and hide the failure.
          if (!response.ok) throw new TypeError(`thumbnail track ${url}: HTTP ${response.status}`);
          tiles = parseThumbnailTrack(await response.text(), url);
          return tiles.length;
        },
        at(time: number): Thumbnail | null {
          if (tiles !== null) {
            return tiles.find((tile) => time >= tile.start && time < tile.end) ?? null;
          }
          const source = imageSource(ctx.getState());
          if (source === null) return null;
          const segment = segmentAtTime(source.rendition.segments, time, source.period.start);
          return segment === null ? null : tileIn(source, segment, time);
        },
        image(tile: Thumbnail): Promise<string> {
          const cached = images.get(tile.url);
          if (cached !== undefined) {
            images.delete(tile.url);
            images.set(tile.url, cached);
            return cached;
          }
          const pending = fetchImage(tile.url);
          // A failed fetch leaves the cache, so the next call retries.
          pending.catch(() => {
            if (images.get(tile.url) === pending) images.delete(tile.url);
          });
          images.set(tile.url, pending);
          if (images.size > IMAGE_CACHE_SIZE) {
            const [oldest, evicted] = images.entries().next().value as [string, Promise<string>];
            images.delete(oldest);
            revoke(evicted);
          }
          return pending;
        },
        get all() {
          if (tiles !== null) return tiles;
          const source = imageSource(ctx.getState());
          return source === null ? [] : allTiles(source);
        },
        get source() {
          if (tiles !== null) return 'app';
          return imageSource(ctx.getState()) === null ? 'none' : 'manifest';
        },
      };
      ctx.registerNamespace('thumbnails', api);
      return () => {
        for (const pending of images.values()) revoke(pending);
        images.clear();
      };
    },
  };
}
