# 14 CDN

This chapter covers using Mattebox from a script tag: which bundle to load,
pinning and integrity, ESM from the CDN, and the MPEG-TS Worker.

## Pick a bundle

Every bundle is one preset behind a `mattebox` global. Load the smallest
one that has what you need. [Chapter 02](02-presets-and-stages.md)
lists what each preset includes.

| Your streams                                  | Bundle                        |
| --------------------------------------------- | ----------------------------- |
| HLS, CMAF segments                            | `mattebox.hls.min.js`         |
| HLS, protected                                | `mattebox.hls-drm.min.js`     |
| HLS with MPEG-TS segments                     | `mattebox.hls-ts.min.js`      |
| HLS with MPEG-TS segments, protected          | `mattebox.hls-ts-drm.min.js`  |
| DASH                                          | `mattebox.dash.min.js`        |
| DASH, protected                               | `mattebox.dash-drm.min.js`    |
| HLS and DASH                                  | `mattebox.dual.min.js`        |
| HLS and DASH, protected                       | `mattebox.dual-drm.min.js`    |
| HLS and DASH with MPEG-TS segments            | `mattebox.dual-ts.min.js`     |
| HLS and DASH with MPEG-TS segments, protected | `mattebox.dual-ts-drm.min.js` |
| Everything, accessories included              | `mattebox.min.js`             |

Every bundle plays on demand and live, adapts quality, recovers, switches
audio, and renders WebVTT. The name says what it adds.

## The script tag

jsDelivr serves the package from npm. Pin the version in the URL. An
unpinned URL follows the latest release and can change under a live page.

```html
<video id="player" controls></video>

<script src="https://cdn.jsdelivr.net/npm/mattebox@0.1.0/dist/cdn/mattebox.hls.min.js" defer></script>
<script type="module">
  const video = document.getElementById('player');
  const engine = mattebox.preset();
  engine.on('error', (error) => console.error(error));
  engine.attach(video).then(() => {
    engine.load('https://example.com/live/master.m3u8');
  });
</script>
```

`defer` keeps the bundle from blocking the parser. The inline script is a
module because `defer` does nothing on an inline script: a module is
deferred too, and deferred scripts run in document order, so it sees the
`mattebox` global. Anywhere else on the page, `mattebox.from(video)`
returns the engine attached to an element.

## The mattebox global

| Member                     | Is                                                                |
| -------------------------- | ----------------------------------------------------------------- |
| `mattebox(options)`        | The engine factory, for building a stack from the stage factories |
| `mattebox.preset(options)` | The bundle's preset: defaults, `config`, `stages`, `without`      |
| `mattebox.preset.stages()` | The preset's stage list, with the same merge applied              |
| `mattebox.hlsCmaf()`, ...  | The stage factories the bundle carries                            |
| `mattebox.from(video)`     | The engine attached to an element                                 |

The preset options are the ones [chapter 02](02-presets-and-stages.md)
describes. Replacing a stage by name is how you pass it options.

```html
<script>
  const engine = mattebox.preset({
    config: { bufferGoalSeconds: 40 },
    stages: [mattebox.recovery({ skipAfter: 2 })],
    without: ['content-steering'],
  });
</script>
```

## Integrity

A pinned URL can have a subresource integrity hash, and a page with a
content security policy needs one. Compute it from the published file.

```sh
curl -s https://cdn.jsdelivr.net/npm/mattebox@0.1.0/dist/cdn/mattebox.hls.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

```html
<script
  src="https://cdn.jsdelivr.net/npm/mattebox@0.1.0/dist/cdn/mattebox.hls.min.js"
  integrity="sha384-<the hash>"
  crossorigin="anonymous"
  defer></script>
```

The hash changes with every version. Update both together.

## ESM from the CDN

A page with ES modules and no bundler can import the ESM build through
jsDelivr's `+esm` endpoint, which rewrites the internal imports to absolute
URLs. Presets and stages import the same way, and stages you don't import
are never fetched.

```html
<script type="module">
  import hls from 'https://cdn.jsdelivr.net/npm/mattebox@0.1.0/presets/hls/+esm';
  import thumbnails from 'https://cdn.jsdelivr.net/npm/mattebox@0.1.0/stages/thumbnails/+esm';

  const engine = hls({ stages: [thumbnails()] });
  await engine.attach(document.querySelector('video'));
  engine.load('https://example.com/live/master.m3u8');
</script>
```

This fetches one file per module, so it makes more requests than a bundle.
Use it on a page that already uses modules, or for a stack no bundle
matches.

## MPEG-TS and the Worker

The `-ts` bundles and `mattebox.min.js` transmux MPEG-TS in a Worker. The
Worker's code is inside the bundle and starts from a blob URL, so one script
tag is all a page loads, from jsDelivr or from your own host, with nothing
to copy beside it. A content security policy must allow `worker-src blob:`
for it to start; where it cannot, transmuxing runs on the main thread and
playback continues.

`workerUrl` points the transmuxer at a file you host instead, for a policy
that forbids blob Workers. The file is the package's
`dist/es2015/containers/ts-transmux/transmux.worker.js`.

```html
<script>
  const engine = mattebox.preset({
    stages: [mattebox.tsTransmux({ workerUrl: '/static/transmux.worker.js' })],
  });
</script>
```

The CMAF-only bundles carry no transmuxer and need no Worker.

## Browser support

The CDN bundles are the default ES2015 build, minified: every browser with
Media Source Extensions, from Chrome 49 and Safari 10 up, and Safari on iOS
17.1 or later, where ManagedMediaSource is available.
[Chapter 13](13-builds-and-targets.md) covers the floor and the opt-in
modern build.

## Example

A live channel with subtitles from one script tag, pinned and verified.

```html
<!doctype html>
<video id="player" controls playsinline></video>

<script
  src="https://cdn.jsdelivr.net/npm/mattebox@0.1.0/dist/cdn/mattebox.hls.min.js"
  integrity="sha384-<the hash>"
  crossorigin="anonymous"
  defer></script>
<script type="module">
  const video = document.getElementById('player');
  const engine = mattebox.preset({ config: { bufferGoalSeconds: 30 } });

  engine.on('error', (error) => {
    if (error.fatal) console.error(error.code, engine.error);
  });

  engine.attach(video).then(() => {
    engine.load('https://example.com/live/master.m3u8');
  });

  window.addEventListener('pagehide', () => engine.detach());
</script>
```

This is the last chapter. The [architecture document](../architecture.md)
covers how the engine is built, for writing your own stage.
