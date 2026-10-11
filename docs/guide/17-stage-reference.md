# 17 Stage reference

This chapter lists every stage, the presets that include it, and the chapter
that describes it. [Chapter 02](02-presets-and-stages.md) explains presets
and how to add or remove a stage.

## Protocols

Import from `mattebox/protocols/<name>`.

| Stage       | Does                                   | In presets               | Guide                                      |
| ----------- | -------------------------------------- | ------------------------ | ------------------------------------------ |
| `hls-cmaf`  | Reads HLS playlists, plays on demand   | `hls*`, `dual*`, `full`  | [03](03-hls-and-dash.md#protocol-adapters) |
| `hls-live`  | Reloads HLS playlists for live streams | `hls*`, `dual*`, `full`  | [04](04-live-streaming.md#live-adapters)   |
| `dash-cmaf` | Reads DASH manifests, plays on demand  | `dash*`, `dual*`, `full` | [03](03-hls-and-dash.md#protocol-adapters) |
| `dash-live` | Reloads DASH manifests for live        | `dash*`, `dual*`, `full` | [04](04-live-streaming.md#live-adapters)   |

## Containers

Import from `mattebox/containers/<name>`.

| Stage          | Does                                   | In presets     | Guide                                                 |
| -------------- | -------------------------------------- | -------------- | ----------------------------------------------------- |
| `ts-transmux`  | Rewraps MPEG-TS as fragmented MP4      | `*-ts`, `full` | [08](08-legacy-transport-streams.md#container-stages) |
| `packed-audio` | Wraps raw AAC frames as fragmented MP4 | `*-ts`, `full` | [08](08-legacy-transport-streams.md#container-stages) |

## Stages in every preset

Import from `mattebox/stages/<name>`. Every preset except `kernel` includes
these.

| Stage                   | Does                                                        | Guide                                                      |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `abr`                   | Picks the rendition from throughput and buffer              | [05](05-quality-and-abr.md#the-abr-stage)                  |
| `abr-cap-size`          | Caps the height to the element's rendered size              | [05](05-quality-and-abr.md#the-abr-stage)                  |
| `codec-switch`          | Changes a buffer's codec when the rendition's codec changes | [05](05-quality-and-abr.md#the-codec-switch-stage)         |
| `recovery`              | Retries, skips, and reloads after an error                  | [09](09-events-and-errors.md#the-recovery-stage)           |
| `content-steering`      | Switches CDN when the manifest names a steering server      | [11](11-network-and-cdn.md#the-content-steering-stage)     |
| `alt-audio`             | Plays an audio rendition apart from the video               | [06](06-audio-and-text.md#the-alt-audio-stage)             |
| `text-webvtt`           | Parses WebVTT subtitles                                     | [06](06-audio-and-text.md#webvtt-subtitles)                |
| `text-webvtt-segmented` | Aligns segmented WebVTT with the media clock                | [06](06-audio-and-text.md#webvtt-subtitles)                |
| `forced-subtitles`      | Shows forced subtitles for the audio language               | [06](06-audio-and-text.md#forced-subtitles)                |
| `text-cea608`           | Decodes CEA-608 captions                                    | [06](06-audio-and-text.md#cea-608-captions)                |
| `nal-scan`              | Finds caption data in fragmented MP4 video                  | [06](06-audio-and-text.md#cea-608-captions)                |
| `cmaf-timing`           | Places each segment at its playlist time                    | [04](04-live-streaming.md#the-cmaf-timing-stage)           |
| `pdt`                   | Maps media time to wall-clock time                          | [04](04-live-streaming.md#the-pdt-stage)                   |
| `codec-probe`           | Reads the codecs from an init segment                       | [08](08-legacy-transport-streams.md#the-codec-probe-stage) |
| `mp4-box`               | Reads MP4 boxes, for `codec-probe` and DASH indexes         | [08](08-legacy-transport-streams.md#the-codec-probe-stage) |
| `aes-128`               | Decrypts AES-128 segments. HLS presets only                 | [08](08-legacy-transport-streams.md#the-aes-128-stage)     |

## Stages in the `-ts` presets

| Stage      | Does                                       | Guide                                                                   |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| `meta-id3` | Reads ID3 metadata from a transport stream | [08](08-legacy-transport-streams.md#stages-that-need-a-container-stage) |

## Stages in the `-drm` presets

| Stage          | Does                                     | Guide                      |
| -------------- | ---------------------------------------- | -------------------------- |
| `eme-core`     | Opens key sessions and requests licenses | [07](07-drm.md#eme-stages) |
| `eme-cenc`     | Widevine, PlayReady, and ClearKey        | [07](07-drm.md#eme-stages) |
| `eme-fairplay` | FairPlay                                 | [07](07-drm.md#fairplay)   |

## Stages only in `full`

| Stage             | Does                                         | Guide                                       |
| ----------------- | -------------------------------------------- | ------------------------------------------- |
| `thumbnails`      | Answers scrub preview images                 | [10](10-thumbnails.md)                      |
| `chapters`        | Answers the chapters of a presentation       | [15](15-chapters.md)                        |
| `trick-play`      | Fast forward and rewind on the I-frame track | [16](16-trick-play.md)                      |
| `timed-metadata`  | Lists date ranges, events, ID3, and emsg     | [06](06-audio-and-text.md#timed-metadata)   |
| `text-cea708`     | Decodes CEA-708 captions                     | [06](06-audio-and-text.md#cea-708-captions) |
| `text-ttml`       | Parses TTML subtitles                        | [06](06-audio-and-text.md#ttml-subtitles)   |
| `hdr`             | Keeps HDR off a screen that cannot show it   | [05](05-quality-and-abr.md#the-hdr-stage)   |
| `qoe`             | Measures startup, rebuffering, and switches  | [12](12-diagnostics.md#qoe-metrics)         |
| `cmsd`            | Reads the CDN's throughput and bitrate hints | [11](11-network-and-cdn.md#the-cmsd-stage)  |
| `rendition-names` | Answers localized track names                | [06](06-audio-and-text.md#track-names)      |

## Stages in no preset

| Stage  | Does                                           | Guide                                      |
| ------ | ---------------------------------------------- | ------------------------------------------ |
| `cmcd` | Sends playback data to the CDN on each request | [11](11-network-and-cdn.md#the-cmcd-stage) |
