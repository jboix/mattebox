/**
 * Draws one thumbnail tile into a card: a clipping box and a tile element
 * whose background is the sprite sheet, scaled to a fixed width. The sheet
 * loads through `engine.thumbnails.image()`, so request hooks apply; a CDN
 * that sends no CORS headers rejects that fetch, and the card falls back to
 * the sheet's own URL, which an image background may load without CORS.
 */

export interface ThumbTile {
  readonly url: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ThumbnailsView {
  at(time: number): ThumbTile | null;
  image?(tile: ThumbTile): Promise<string>;
}

/** Sheets whose transport fetch failed; they load by URL from then on. */
const direct = new Set<string>();

/** Shows the tile covering `time` in `box`, or hides the box when there is none. */
export function paintThumb(
  box: HTMLElement,
  tileEl: HTMLElement,
  api: ThumbnailsView | null,
  time: number,
  width: number,
): void {
  const tile = api?.at(time) ?? null;
  box.hidden = tile === null;
  if (tile === null || api === null) return;
  const scale = width / tile.width;
  box.style.width = `${width}px`;
  box.style.height = `${Math.round(tile.height * scale)}px`;
  tileEl.style.width = `${tile.width}px`;
  tileEl.style.height = `${tile.height}px`;
  tileEl.style.transform = `scale(${scale})`;
  tileEl.style.backgroundPosition = `-${tile.x}px -${tile.y}px`;
  tileEl.dataset.sheet = tile.url;
  if (api.image === undefined || direct.has(tile.url)) {
    tileEl.style.backgroundImage = `url("${tile.url}")`;
    return;
  }
  api.image(tile).then(
    (objectUrl) => {
      // The pointer may have moved on to another sheet while this one loaded.
      if (tileEl.dataset.sheet === tile.url) tileEl.style.backgroundImage = `url("${objectUrl}")`;
    },
    () => {
      direct.add(tile.url);
      if (tileEl.dataset.sheet === tile.url) tileEl.style.backgroundImage = `url("${tile.url}")`;
    },
  );
}
