# 13 Builds and targets

This chapter covers what the package ships and how to reach older devices.

## Build outputs

| Output      | Path           | For                                      |
| ----------- | -------------- | ---------------------------------------- |
| Default ESM | `dist/es2015/` | Apps with a bundler. The default         |
| Modern ESM  | `dist/`        | Apps that only target evergreen browsers |
| CDN bundles | `dist/cdn/`    | A plain script tag, no bundler           |

The default build is ES2015, one module per file, with `sideEffects: false`,
so your bundler tree-shakes it. No bundler configuration is needed, and it
runs on every browser with Media Source Extensions. Nothing is polyfilled:
Promise, Map, fetch, TextDecoder, and WebCrypto are assumed, since every
browser with MSE has them.

## CDN bundles

One bundle per preset, each exposing a `mattebox` global. The global is the
engine factory, `mattebox.preset()` is the bundle's preset, and the preset's
stage factories are on it too. Nothing tree-shakes, so pick the smallest
bundle that has what you need.

| Bundle                              | Preset                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/cdn/mattebox.<preset>.min.js` | One per preset in [chapter 02](02-presets-and-stages.md): `hls`, `hls-drm`, `hls-ts`, `hls-ts-drm`, `dash`, `dash-drm`, `dual`, `dual-drm`, `dual-ts`, `dual-ts-drm` |
| `dist/cdn/mattebox.min.js`          | `full`                                                                                                                                                               |

The bundles are the same ES2015 build as the default ESM, minified.

```html
<script src="https://cdn.jsdelivr.net/npm/mattebox/dist/cdn/mattebox.hls.min.js"></script>
<script>
  const engine = mattebox.preset();
  engine.attach(document.querySelector('video')).then(() => {
    engine.load('https://example.com/stream/master.m3u8');
  });
</script>
```

Every bundle that carries the transmuxer (`-ts` and `full`) has the Worker's
code inside and starts it from a blob URL, for `mattebox.tsTransmux()` and
the preset's own instance alike, so one file is all a page loads.
[Chapter 14](14-cdn.md) covers the script tag in detail: versions, integrity
hashes, the ESM form, and hosting the Worker elsewhere.

## The modern build

The modern build is ES2022, for apps that only serve evergreen browsers. It
is about eight percent smaller than the default build. Same modules, same
paths, under `dist/`, behind the `modern` export condition. Enable that
condition in your bundler and every `mattebox` import resolves to it.

```ts
// vite.config.ts
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  resolve: { conditions: ['modern', ...defaultClientConditions] },
});
```

```js
// webpack.config.js
module.exports = {
  resolve: { conditionNames: ['modern', '...'] },
};
```

Leave it off unless you know your browser floor. A bundler that does not
transpile `node_modules` (webpack's default) ships the ES2022 syntax as is.

## Browser support

| Build   | Requires                                                                              |
| ------- | ------------------------------------------------------------------------------------- |
| Default | ES2015: Chrome 49, Safari 10, Firefox 45, Edge 13, and the TV platforms built on them |
| Modern  | ES2022 and native ES modules                                                          |

Both need Media Source Extensions. Safari on iOS needs 17.1 or later, where
ManagedMediaSource is available.

## Size

[Chapter 02](02-presets-and-stages.md#size-per-preset) has the size per
preset. For a hand-built stack, measure the file that imports exactly what
you ship.

## Example

One stack for both modern browsers and TVs.

```ts
// src/player.ts
import { mattebox } from 'mattebox';
import dashCmaf from 'mattebox/protocols/dash-cmaf';
import dashLive from 'mattebox/protocols/dash-live';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import hlsLive from 'mattebox/protocols/hls-live';
import abr from 'mattebox/stages/abr';
import recovery from 'mattebox/stages/recovery';
import textWebvtt from 'mattebox/stages/text-webvtt';
import textWebvttSegmented from 'mattebox/stages/text-webvtt-segmented';

export function createPlayer() {
  return mattebox({
    stages: [
      hlsCmaf(),
      hlsLive(),
      dashCmaf(),
      dashLive(),
      abr(),
      recovery(),
      textWebvtt(),
      textWebvttSegmented(),
    ],
  });
}
```

The default build already works on TVs. Add the `modern` condition to a
web-only build if the last few percent matter.

Next: [14 The CDN](14-cdn.md).
