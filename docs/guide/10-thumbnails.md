# 10 Thumbnails

This chapter covers scrub previews: the images a UI shows while the viewer
drags the progress bar.

## The track format

The stage reads a WebVTT thumbnail track. Each cue names an image and a
rectangle inside it with an `#xywh` fragment. Packagers and video platforms
produce this format for sprite sheets.

```
WEBVTT

00:00:00.000 --> 00:00:05.000
sprite-1.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprite-1.jpg#xywh=160,0,160,90
```

The stage does not find the track in the manifest. Your app passes the URL.

## engine.thumbnails

```ts
import thumbnails from 'mattebox/stages/thumbnails';

const engine = mattebox({ stages: [hlsCmaf(), thumbnails()] });

await engine.attach(video);
const count = await engine.thumbnails.load('https://example.com/vod/thumbs.vtt');

const tile = engine.thumbnails.at(42); // { url, start, end, x, y, width, height } or null
```

| Member      | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `load(url)` | Fetches and parses the track. Resolves to the tile count |
| `at(time)`  | The tile covering a presentation time, or null           |
| `all`       | Every tile, in order                                     |

The fetch goes through the transport, so request hooks such as
authentication headers and CMCD apply to it.

## Draw a tile

A tile is a rectangle inside a sprite image. Draw it with a background
position or with `drawImage`.

```ts
function showPreview(time) {
  const tile = engine.thumbnails.at(time);
  if (tile === null) return;
  preview.style.width = `${tile.width}px`;
  preview.style.height = `${tile.height}px`;
  preview.style.backgroundImage = `url(${tile.url})`;
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
