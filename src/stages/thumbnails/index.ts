/**
 * Thumbnails: the trick-play images a scrubbing UI shows. The common shape is
 * a WebVTT track whose cues point at sprite-sheet tiles with an #xywh media
 * fragment. This stage parses such a track and answers "which tile covers this
 * time" through `engine.thumbnails`. It fetches through the transport seam, so
 * request hooks (auth, cmcd, steering) apply to the thumbnail track too.
 *
 * It does not auto-discover the track from the manifest; HLS image playlists
 * are a separate parse. The app points it at a track URL, which is what the
 * playground does.
 */
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

function timestamp(text: string): number {
  const parts = text.trim().split(':').map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/** Parses a WebVTT thumbnail track into tiles, resolving URLs against a base. */
export function parseThumbnailTrack(text: string, baseUrl: string): Thumbnail[] {
  const thumbnails: Thumbnail[] = [];
  const blocks = text.replace(/\r/g, '').split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line !== '');
    const timing = lines.find((line) => line.includes('-->'));
    const target = lines.find((line) => !line.includes('-->') && line !== 'WEBVTT' && line !== '');
    if (timing === undefined || target === undefined) continue;
    const [from, to] = timing.split('-->');
    const start = timestamp(from ?? '');
    const end = timestamp(to ?? '');
    const [rawUrl, fragment] = target.split('#');
    const url = new URL(rawUrl ?? '', baseUrl).href;
    let [x, y, width, height] = [0, 0, 0, 0];
    const xywh = /xywh=(?:pixel:)?(\d+),(\d+),(\d+),(\d+)/.exec(fragment ?? '');
    if (xywh !== null) {
      x = Number(xywh[1]);
      y = Number(xywh[2]);
      width = Number(xywh[3]);
      height = Number(xywh[4]);
    }
    thumbnails.push({ url, start, end, x, y, width, height });
  }
  return thumbnails;
}

export interface ThumbnailsApi {
  /** Fetches and parses a WebVTT thumbnail track at a URL. */
  load(url: string): Promise<number>;
  /** The tile covering a presentation time, or null. */
  at(time: number): Thumbnail | null;
  /** Every parsed tile, in order. */
  readonly all: readonly Thumbnail[];
}

export default function thumbnails(): Stage {
  return {
    name: 'thumbnails',
    provides: ['thumbnails'],
    requires: ['transport'],
    install(ctx) {
      let tiles: Thumbnail[] = [];
      const api: ThumbnailsApi = {
        async load(url: string): Promise<number> {
          const response = await ctx.request(url, { method: 'GET' });
          const text = await response.text();
          tiles = parseThumbnailTrack(text, url);
          return tiles.length;
        },
        at(time: number): Thumbnail | null {
          return tiles.find((tile) => time >= tile.start && time < tile.end) ?? null;
        },
        get all() {
          return tiles;
        },
      };
      ctx.registerNamespace('thumbnails', api);
    },
  };
}
