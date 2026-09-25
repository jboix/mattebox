# 10 Thumbnails

This chapter covers scrub previews: the images a UI shows while the viewer
drags the progress bar.

## Sources

The stage reads tiles from two sources.

| Source   | What it is                                                                              | How it loads                     |
| -------- | --------------------------------------------------------------------------------------- | -------------------------------- |
| Manifest | An HLS `EXT-X-IMAGE-STREAM-INF` playlist or a DASH image AdaptationSet with a tile grid | By itself, when the source loads |
| Track    | A WebVTT file whose cues point at sprite tiles with an `#xywh` fragment                 | `engine.thumbnails.load(url)`    |

A track you load wins over the manifest.

### From the manifest

You add the stage and load the source. The stage finds the image track and
answers `at(time)` with no URL from you.

- HLS: each `EXT-X-IMAGE-STREAM-INF` is one image playlist. Its segments are
  sprite sheets, and `EXT-X-TILES` gives the grid (`LAYOUT="5x2"`), the tile
  size, and the seconds each tile covers.
- DASH: an AdaptationSet with `contentType="image"` and an
  `EssentialProperty` with the `http://dashif.org/thumbnail_tile` scheme and
  a value such as `10x1`. The Representation's `width` and `height` are the
  whole sheet.

The stage selects the image track (`engine.tracks.active('image')`). Only
then does the HLS adapter fetch its playlist. The engine never buffers an
image track; images load when you ask for them.

### From a WebVTT track

Each cue names an image and a rectangle inside it with an `#xywh` fragment.
Packagers and video platforms produce this format for sprite sheets.

```
WEBVTT

00:00:00.000 --> 00:00:05.000
sprite-1.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprite-1.jpg#xywh=160,0,160,90
```

## engine.thumbnails

```ts
import thumbnails from 'mattebox/stages/thumbnails';

const engine = mattebox({ stages: [hlsCmaf(), thumbnails()] });

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');

const tile = engine.thumbnails.at(42); // { url, start, end, x, y, width, height } or null
```

| Member        | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `load(url)`   | Fetches and parses a WebVTT track. Resolves to the tile count           |
| `at(time)`    | The tile covering a presentation time, or null                          |
| `image(tile)` | The tile's sprite sheet as an object URL, fetched through the transport |
| `all`         | Every tile, in order. Empty for a live DASH template with no end        |
| `source`      | `'none'`, `'app'` (a loaded track), or `'manifest'`                     |

`load` and `image` fetch through the transport, so request hooks such as
authentication headers and CMCD apply. `image` keeps the last 16 sheets and
revokes the object URLs it drops and all of them on detach. The fetch needs
CORS headers on the image. Without them, use `tile.url` directly.

Tile positions can be fractional: a 2048 pixel sheet split into 10 columns
has tiles 204.8 pixels wide.

## Draw a tile

A tile is a rectangle inside a sprite image. Draw it with a background
position or with `drawImage`.

```ts
async function showPreview(time) {
  const tile = engine.thumbnails.at(time);
  if (tile === null) return;
  preview.style.width = `${tile.width}px`;
  preview.style.height = `${tile.height}px`;
  preview.style.backgroundImage = `url(${await engine.thumbnails.image(tile)})`;
  preview.style.backgroundPosition = `-${tile.x}px -${tile.y}px`;
}
```

## Example

A scrub bar with a hover preview.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import thumbnails from 'mattebox/stages/thumbnails';

const engine = mattebox({ stages: [hlsCmaf(), thumbnails()] });

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');
// Only when the manifest carries no image track:
await engine.thumbnails.load('https://example.com/vod/thumbs.vtt');

scrubBar.addEventListener('pointermove', (event) => {
  const fraction = event.offsetX / scrubBar.clientWidth;
  const tile = engine.thumbnails.at(fraction * video.duration);
  preview.hidden = tile === null;
  if (tile === null) return;
  preview.style.backgroundImage = `url(${tile.url})`;
  preview.style.backgroundPosition = `-${tile.x}px -${tile.y}px`;
  preview.style.left = `${event.offsetX - tile.width / 2}px`;
});
```

Next: [11 Network and CDN](11-network-and-cdn.md).
