# 03 HLS and DASH

This chapter covers the protocol adapters.

## One engine for both

With CMAF content, HLS and DASH differ only in the manifest. Each adapter
parses its format into the same model, and everything else (scheduling,
buffering, quality, seeking, track switching) works on that model.

So there is one API. Quality, tracks, events, and errors are the same for
both. Moving from HLS to DASH changes the manifest URL and nothing else.

## Protocol adapters

| Adapter     | Handles                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `hls-cmaf`  | Multivariant playlists, media playlists, `EXT-X-MAP`, byte ranges, `EXT-X-MEDIA` groups, keys                          |
| `dash-cmaf` | `SegmentTemplate` with `$Number$` and `$Time$`, `SegmentTimeline`, `SegmentBase` with `sidx`, `SegmentList`, `BaseURL` |
| `hls-live`  | Everything live needs on top of `hls-cmaf`. See [chapter 04](04-live-streaming.md)                                     |
| `dash-live` | Everything live needs on top of `dash-cmaf`. See [chapter 04](04-live-streaming.md)                                    |

Load one or both. Each adapter checks the manifest bytes and skips what is
not its format.

```ts
import dashCmaf from 'mattebox/protocols/dash-cmaf';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';

const engine = mattebox({ stages: [hlsCmaf(), dashCmaf()] });
engine.load(url); // .m3u8 or .mpd
```

## Multi-period MPDs

`dash-cmaf` plays a static MPD with several Periods as one presentation,
as for server-side ad insertion.

- Each track keeps one id across the periods. A period's tracks match
  those of the first by the period continuity or connectivity descriptor,
  then the AdaptationSet `id`, then language, role, and codec.
- `engine.tracks.available` lists one set, with no duplicate per period. A
  period boundary fires no `tracks:changed`.
- A period without the selected language plays its closest audio. A
  subtitle track with nothing in a period shows nothing there.
- Each boundary resets the timestamp offset from the media, and a period
  with its own init segment gets it before its first segment.

Two cases play the first period only, as before:

| Case                        | Why                                                   |
| --------------------------- | ----------------------------------------------------- |
| A live (`dynamic`) MPD      | Listing a later period's segments needs the clock     |
| A period with `SegmentBase` | Its segments are known only once its index is fetched |

A period whose audio or video uses another codec family than the first
period's (an HEVC ad in H.264 content) is skipped: playback seeks past
it, and the engine emits a non-fatal `MEDIA_CODEC_MISMATCH` error naming
both codecs and the period.

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

Without the `webm` container, `dash-cmaf` leaves out WebM Representations
(`video/webm`, `audio/webm`). A manifest that offers WebM beside MP4 plays
its MP4, and no menu lists the WebM tracks.

Legacy HLS with MPEG-TS segments or raw AAC segments needs the container
stages from [chapter 08](08-legacy-transport-streams.md). CMAF whose
`tfdt` does not start at zero, a live broadcast clock or a VOD encoder
offset, needs `cmaf-timing`, which [chapter 04](04-live-streaming.md)
explains.

## WebM in DASH

Add the `webm` container to play DASH Representations with WebM segments.
MSE takes WebM as it is, so the engine rewraps nothing. The container is in
no preset.

```ts
import webm from 'mattebox/containers/webm';
import dash from 'mattebox/presets/dash';

const engine = dash({ stages: [webm()] });
```

| Addressing                       | How the segments are found                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `SegmentBase` with `indexRange`  | The container fetches the `Initialization` range and the Cues, one segment per Cluster |
| `SegmentTemplate`, `SegmentList` | From the MPD, as for MP4                                                               |

- The codecs come from the MPD as they are: `vp9`, `vp09.*`, `av01.*`,
  `opus`, `vorbis`. The browser's `MediaSource.isTypeSupported` decides
  which renditions play.
- A WebM `SegmentBase` needs an `Initialization` range. The Cues count
  Cluster positions from the start of the Segment's data, which only that
  range locates ([RFC 9559 §16](https://www.rfc-editor.org/rfc/rfc9559#section-16)).
- The file needs a `Duration` in its Info. It ends the last segment, as in
  [Shaka Player](https://github.com/shaka-project/shaka-player/blob/main/lib/dash/webm_segment_index_parser.js).
- A live (`dynamic`) MPD with WebM `SegmentTemplate` is not tested. Its
  segments land at their MPD time, and nothing reads the Cluster
  timestamps to check it.
- An index that fails or holds no segment excludes its rendition for 15
  seconds and reports a non-fatal `MEDIA_CONTAINER_INVALID`. Change the
  wait with `webm({ unavailableRetrySeconds })`.

These do not work with WebM:

| Feature                                 | Why                                                                  |
| --------------------------------------- | -------------------------------------------------------------------- |
| `cmaf-timing`                           | It reads ISO BMFF decode times. WebM segments land at their MPD time |
| CEA-608 and CEA-708 captions            | `nal-scan` reads H.264 and HEVC in fMP4                              |
| `emsg` events                           | The box exists only in ISO BMFF                                      |
| Encrypted WebM                          | Not tested. The DRM stages expect CENC in ISO BMFF                   |
| A rendition switch between WebM and MP4 | One track holds one container; the two are separate tracks           |

Chromium and Firefox play VP9 and Opus in WebM. Safari's support depends
on the version and the device. The playground's capabilities table shows
what your browser accepts.

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

- An audio rendition repeated in several groups (same `NAME`, `LANGUAGE`, and
  other attributes; another `URI` or `CHANNELS`) is one track with one
  rendition per group. You see one English track, not one per group.
- The engine plays that track from the first group the browser decodes, in
  manifest order, or from the group the playing video variant needs.
- Variants that read one video playlist and differ only by audio group are
  one quality choice. `engine.quality.allowed` keeps the one in the playing
  audio group, so ABR never changes the audio codec on its own.
- A pin on another of those variants plays the kept one, with no warning.

Two kinds of track never play in the video element.

| Track            | `contentType` | `role`  | HLS source                 | DASH source                                | Used by             |
| ---------------- | ------------- | ------- | -------------------------- | ------------------------------------------ | ------------------- |
| Thumbnail images | `image`       |         | `EXT-X-IMAGE-STREAM-INF`   | `AdaptationSet` with `contentType="image"` | `engine.thumbnails` |
| I-frame video    | `video`       | `trick` | `EXT-X-I-FRAME-STREAM-INF` | trick-mode `AdaptationSet`                 | `engine.trick`      |

Both appear in `engine.tracks.available`. `engine.quality.renditions` never
lists I-frame renditions, and selecting the I-frame track is rejected.

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

## 360° video

A video rendition carries `projection` when the manifest says its picture
maps onto a sphere. The engine only reports it. Drawing the sphere is the
player's job, such as `@mattebox/player-360`.

| `projection`             | HLS `REQ-VIDEO-LAYOUT` |
| ------------------------ | ---------------------- |
| `'equirectangular'`      | `PROJ-EQUI`            |
| `'half-equirectangular'` | `PROJ-HEQU`            |

- The engine reads the first entry of the attribute, the preferred one.
- DASH has no attribute the engine reads yet, and neither do the boxes of
  the init segment. A stream that states its projection only there has no
  `projection`. Your page or connector tells the player instead.

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
