# 01 Getting started

This chapter goes from install to a playing HLS stream.

## Requirements

Mattebox runs in browsers with Media Source Extensions. That covers Chrome,
Edge, Firefox, Safari on macOS and iPadOS, and Safari on iOS 17.1 or later
through ManagedMediaSource. The package is ESM and has no runtime
dependencies.

## Install

```sh
npm install mattebox
```

## Create an engine

An engine is the kernel plus the stages you pass in. The kernel alone attaches
and manages buffers, but it cannot read a manifest. Add a protocol adapter for
the format you stream.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';

const engine = mattebox({ stages: [hlsCmaf()] });
```

Every stage is a factory function. It returns a plain object, and nothing
runs until `attach`. Stages you don't import never end up in your bundle.

## Attach and load

Attach the engine to a media element, then load a manifest URL.

```ts
const video = document.querySelector('video');

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');
video.play();
```

The engine fetches the manifest and the matching adapter parses it.
Playback starts on the lowest rendition and stays there until you add the
`abr` stage, see [chapter 05](05-quality-and-abr.md).

## The media element

Mattebox does not wrap the media element. Use the element for everything
the browser already does.

| Need                      | Use                                |
| ------------------------- | ---------------------------------- |
| Play, pause, seek, volume | The element                        |
| Buffered and seekable     | The element                        |
| Native controls           | The element's `controls` attribute |
| Renditions and quality    | `engine.quality`                   |
| Track selection           | `engine.tracks`                    |
| Throughput and trace      | `engine.stats`                     |
| The last fatal error      | `engine.error`                     |

`mattebox.from(video)` returns the engine attached to an element.

```ts
import { mattebox } from 'mattebox';

const engine = mattebox.from(video);
```

The CDN bundles expose the same `mattebox` as a global, plus the bundle's
preset and stage factories. [Chapter 14](14-cdn.md) has the script tag.

## Unload and detach

Unload stops fetching and clears the buffers. Detach removes the engine from
the element and runs every stage's teardown. Both are safe to call twice.
Loading another URL replaces the current source, so a player that switches
streams only ever calls `load`.

```ts
engine.unload();
await engine.detach();
```

Call `detach` when the element leaves the page. Otherwise a single-page app
leaks a media pipeline on every navigation.

## Example

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';

const video = document.querySelector('video');
const engine = mattebox({ stages: [hlsCmaf()] });

engine.on('error', (error) => console.error(error));

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');

window.addEventListener('pagehide', () => engine.detach());
```

Next: [02 Presets and stages](02-presets-and-stages.md).
