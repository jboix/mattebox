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

## Suspend and resume

Suspend stops every request while the source stays loaded: the element
stays attached, the buffers stay, and no playlist reload, segment fetch, or
steering refresh runs until resume. Use it when the element is paused for a
long time and nothing local will play, such as while a Chromecast or
AirPlay receiver plays the same content, or while the page is in the
background. A paused live stream would otherwise reload its playlists for
as long as the pause lasts.

```ts
video.pause();
engine.suspend();
// later
engine.resume();
video.currentTime = remoteTime;
await video.play();
```

Suspend expects a paused element and is accepted in the ready phase only.
Anywhere else, such as while the manifest is still loading, the reducer
rejects it with a `command:rejected` event and nothing changes. Resume
refills the buffer from the playhead. A live presentation reloads its
playlists first and rejoins at the live edge, the way a fresh load does, so
`engine.live.edge` reads null while suspended.

Suspend does not close DRM key sessions and does not refresh signed URLs. A
license or a token that expires during the freeze behaves on resume the
way it does after a long pause today: the key reports `DRM_KEY_EXPIRED`
and playback waits, or the next request fails.

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
