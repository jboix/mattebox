# 08 Legacy transport streams

This chapter covers HLS content that MSE cannot accept directly: MPEG-TS
segments and raw AAC segments.

## When you need this

Check the media playlist. `.ts` segments are MPEG-TS, `.aac` segments are
packed audio. Both need a container stage to turn them into fragmented MP4
before they reach a SourceBuffer.

If your packager can output CMAF instead, do that. These are the biggest
stages.

## Container stages

| Stage          | Handles                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `ts-transmux`  | Demuxes MPEG-TS into H.264 and AAC and rewraps them as fMP4, in a Worker |
| `packed-audio` | Wraps raw AAC frames, with or without a leading ID3 tag, as fMP4         |

```ts
import packedAudio from 'mattebox/containers/packed-audio';
import tsTransmux from 'mattebox/containers/ts-transmux';

const engine = mattebox({ stages: [hlsCmaf(), tsTransmux(), packedAudio()] });
```

Both check each segment and pass CMAF through untouched, so they can stay
loaded when you have a mix of both.

## The Worker

`ts-transmux` runs in a Web Worker so it never blocks the main thread. The
Worker URL is `new URL('./transmux.worker.js', import.meta.url)`, which
Vite, Rollup, Rolldown, esbuild, and webpack 5 all handle without
configuration.

Two options cover the other cases.

| Option          | Use                                                         |
| --------------- | ----------------------------------------------------------- |
| `workerUrl`     | A URL you host yourself, for strict Content Security Policy |
| `disableWorker` | Runs on the main thread. For tests and headless runs        |

```ts
tsTransmux({ workerUrl: new URL('/static/mattebox-transmux.js', location.href) });
```

The CDN bundle ships the Worker as `transmux.worker.js` next to
`mattebox.min.js` and resolves it from the script's own URL, so a script tag
needs neither option. See [chapter 13](13-builds-and-targets.md).

## Stages that need a container stage

These stages depend on the container stages.

| Stage         | Adds                                                 | See                                |
| ------------- | ---------------------------------------------------- | ---------------------------------- |
| `text-cea608` | Captions from the SEI units in the video             | [Chapter 06](06-audio-and-text.md) |
| `meta-id3`    | ID3 timed metadata as cues                           | [Chapter 06](06-audio-and-text.md) |
| `cmaf-timing` | Not needed. The transmuxer already normalizes timing | [Chapter 04](04-live-streaming.md) |

## The codec-probe stage

Manifests leave out or get codec strings wrong, and MSE needs the exact one.
`codec-probe` reads the init segment and reports what it finds. It requires
`mp4-box`.

```ts
import codecProbe from 'mattebox/stages/codec-probe';
import mp4Box from 'mattebox/stages/mp4-box';

const engine = mattebox({ stages: [hlsCmaf(), mp4Box(), codecProbe()] });

engine.on('codecprobe:detected', () => {
  console.log(engine.codecProbe.detected, engine.codecProbe.mimeType);
});
```

It also fixes buffers the manifest cannot type. A bare media playlist
declares no codecs, and Chrome refuses a SourceBuffer opened as plain
`video/mp4`. With `codec-probe` loaded, the buffer waits for the first
segment and opens with the codecs read from it. Without it, the bare type
is tried. When the manifest does declare codecs, that string is used, and a
mismatch shows up on the event.

## The aes-128 stage

`EXT-X-KEY:METHOD=AES-128` encrypts whole segments. This is not DRM: the key
is a plain 16-byte file and the EME stages are not involved. The `aes-128`
stage fetches keys through the transport, caches them by URL, and decrypts
each segment before the transmuxer, using the playlist's IV or the media
sequence number. `METHOD=NONE` stops decryption for the segments after it.
It works on CMAF segments too.

```ts
import aes128 from 'mattebox/stages/aes-128';

const engine = mattebox({ stages: [hlsCmaf(), tsTransmux(), aes128()] });
```

`SAMPLE-AES`, which encrypts inside the elementary stream, is not covered.

## Example

Every kind of HLS, with captions and metadata.

```ts
import { mattebox } from 'mattebox';
import packedAudio from 'mattebox/containers/packed-audio';
import tsTransmux from 'mattebox/containers/ts-transmux';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import hlsLive from 'mattebox/protocols/hls-live';
import abr from 'mattebox/stages/abr';
import metaId3 from 'mattebox/stages/meta-id3';
import textCea608 from 'mattebox/stages/text-cea608';

const engine = mattebox({
  stages: [hlsCmaf(), hlsLive(), abr(), tsTransmux(), packedAudio(), textCea608(), metaId3()],
});

await engine.attach(document.querySelector('video'));
engine.load('https://example.com/legacy/master.m3u8');
```

Next: [09 Events and errors](09-events-and-errors.md).
