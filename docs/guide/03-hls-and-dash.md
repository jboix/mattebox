# 03 HLS and DASH

This chapter covers the protocol adapters.

## One engine for both

With CMAF content, HLS and DASH differ only in the manifest. Each adapter
parses its format into the same model, and everything else (scheduling,
buffering, quality, seeking, track switching) works on that model.

So there is one API. Quality, tracks, events, and errors are the same for
both. Moving from HLS to DASH changes the manifest URL and nothing else.

## Protocol adapters

| Adapter     | Handles                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `hls-cmaf`  | Multivariant playlists, media playlists, `EXT-X-MAP`, byte ranges, `EXT-X-MEDIA` groups, keys           |
| `dash-cmaf` | `SegmentTemplate` with `$Number$` and `$Time$`, `SegmentTimeline`, `SegmentBase` with `sidx`, `BaseURL` |
| `hls-live`  | Everything live needs on top of `hls-cmaf`. See [chapter 04](04-live-streaming.md)                      |
| `dash-live` | Everything live needs on top of `dash-cmaf`. See [chapter 04](04-live-streaming.md)                     |

Load one or both. Each adapter checks the manifest bytes and skips what is
not its format.

```ts
import dashCmaf from 'mattebox/protocols/dash-cmaf';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';

const engine = mattebox({ stages: [hlsCmaf(), dashCmaf()] });
engine.load(url); // .m3u8 or .mpd
```

## The mimeType option

If you know the manifest type, pass it. The adapter for that type parses
without sniffing, and a type no loaded adapter handles fails right away,
before any request.

```ts
engine.load(url, { mimeType: 'application/dash+xml' });
```

The adapters declare these types. Case and parameters are ignored.

| Adapter     | Types                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| `hls-cmaf`  | `application/vnd.apple.mpegurl`, `application/x-mpegurl`, `audio/mpegurl`, `audio/x-mpegurl` |
| `dash-cmaf` | `application/dash+xml`                                                                       |

## Unsupported sources

The engine only plays through MediaSource and never sets the element's
`src`. An mp3 or a progressive mp4 has no manifest. Route those yourself
with `engine.accepts` and `video.canPlayType`.

```ts
function play(url, type) {
  if (engine.accepts(type)) {
    engine.load(url, { mimeType: type });
  } else if (video.canPlayType(type) !== '') {
    engine.detach().then(() => {
      video.src = url;
    });
  }
}
```

Detach before setting `src`, because an attached engine owns the element's
`srcObject`. Without a known type, load through the engine and fall back on
a `MANIFEST_UNSUPPORTED` error. That error also covers an audio or video
Content-Type on the manifest response, and bytes no adapter recognizes.

## AirPlay

Safari opens a ManagedMediaSource only with remote playback disabled or
with an AirPlay source alternative, so by default the engine sets
`disableRemotePlayback` and the element offers no AirPlay target. Pass a
URL of the same content the receiver can play on its own, an HLS playlist
in practice, and the engine attaches through two `<source>` children
instead: the MediaSource first, that URL second.

```ts
await engine.attach(video, { airplay: { url: 'https://cdn.example/master.m3u8' } });
engine.load('https://cdn.example/master.m3u8', { mimeType: 'application/vnd.apple.mpegurl' });
```

Safari plays the MediaSource and hands the second URL to the target the
viewer picks, which plays it itself. The type defaults to
`application/x-mpegURL`. Remote playback stays enabled, so `<video>`
controls and the RemotePlayback API show the target.

The alternative has to be playable by the receiver without the engine.
Drop the option for DASH, and for content the receiver cannot decrypt:
FairPlay over AirPlay needs a key session the engine does not open.

## Segment formats

The adapters expect CMAF (fragmented MP4), which is what MSE accepts
directly.

Legacy HLS with MPEG-TS segments or raw AAC segments needs the container
stages from [chapter 08](08-legacy-transport-streams.md). CMAF whose
`tfdt` does not start at zero, a live broadcast clock or a VOD encoder
offset, needs `cmaf-timing`, which [chapter 04](04-live-streaming.md)
explains.

## Tracks and renditions

The engine uses tracks and renditions, not levels or variants.

| Term      | Meaning                                                           | HLS source                              | DASH source      |
| --------- | ----------------------------------------------------------------- | --------------------------------------- | ---------------- |
| Track     | One selectable stream: the video, a German audio track, subtitles | `EXT-X-MEDIA` group or the variant list | `AdaptationSet`  |
| Rendition | One quality within a track                                        | `EXT-X-STREAM-INF`                      | `Representation` |

An HLS variant ties a video rendition to an audio group and a subtitle
group. The adapter splits that up and records which audio and text tracks
each video rendition needs, and the engine keeps them consistent on quality
changes. DASH already separates them.

## List tracks and renditions

After the manifest loads, read them from `engine.tracks` and
`engine.quality`.

```ts
engine.on('tracks:changed', () => {
  for (const track of engine.tracks.available) {
    console.log(track.contentType, track.id, track.lang ?? '');
  }
  for (const rendition of engine.quality.renditions) {
    console.log(rendition.height, rendition.bitrate, rendition.codecs);
  }
});
```

## Example

Play either format and log the renditions.

```ts
import { mattebox } from 'mattebox';
import dashCmaf from 'mattebox/protocols/dash-cmaf';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';

const engine = mattebox({ stages: [hlsCmaf(), dashCmaf()] });

engine.on('tracks:changed', () => {
  const ladder = engine.quality.renditions.map((r) => `${r.height}p`).join(', ');
  console.log(`renditions: ${ladder}`);
});

await engine.attach(document.querySelector('video'));
engine.load(new URLSearchParams(location.search).get('src'));
```

Next: [04 Live streaming](04-live-streaming.md).
