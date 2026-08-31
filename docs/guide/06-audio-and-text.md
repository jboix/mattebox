# 06 Audio and text

This chapter covers track selection, alternate audio, subtitles, captions,
and timed metadata.

## engine.tracks

Every selectable stream is a track. Audio and video always have one
selected. Text and metadata can be deselected.

```ts
const t = engine.tracks;

t.available;          // every track the manifest declared
t.active('audio');    // the selected audio track, or null
t.select('audio:de'); // switch by track id
t.deselect('text');   // stop the subtitle pipeline and clear its cues
```

A track is listed but not selectable until a stage handles its content
type. Text tracks need a text stage.

## The alt-audio stage

The kernel already plays a separate audio track. The `alt-audio` stage adds
the switching: when a video rendition change needs a different audio group,
the audio track follows and keeps the viewer's language. It requires
`codec-switch`.

```ts
import altAudio from 'mattebox/stages/alt-audio';
import codecSwitch from 'mattebox/stages/codec-switch';

const engine = mattebox({ stages: [hlsCmaf(), codecSwitch(), altAudio()] });
```

A language chosen through `engine.tracks.select` is remembered and re-applied
after every group switch.

## WebVTT subtitles

Text is a third pipeline next to audio and video, with its own fetching and
buffer goal. Cues go to a native `TextTrack`, so the browser renders them
and lists them in its caption menu.

| Stage                   | Handles                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `text-webvtt`           | WebVTT files and DASH WebVTT segments                                          |
| `text-webvtt-segmented` | HLS subtitle playlists, where each segment carries an `X-TIMESTAMP-MAP` offset |

Load both for HLS, only `text-webvtt` for DASH. A DASH subtitle
representation that is one WebVTT file at a `BaseURL` is read as one segment
covering the period.

```ts
import textWebvtt from 'mattebox/stages/text-webvtt';
import textWebvttSegmented from 'mattebox/stages/text-webvtt-segmented';

const engine = mattebox({ stages: [hlsCmaf(), textWebvtt(), textWebvttSegmented()] });
```

Select a subtitle track like any other.

```ts
const german = engine.tracks.available.find((t) => t.contentType === 'text' && t.lang === 'de');
if (german) engine.tracks.select(german.id);
```

Every text track in the manifest gets a `TextTrack` on the element as soon
as the manifest loads. Selection is synced both ways: selecting in the
engine sets that native track to `showing` and the others to `disabled`, and
picking in the browser's caption menu selects in the engine. Turning
captions off there deselects. Listen for `tracks:selected` to update your
own menu.

## CEA-608 captions

CEA-608 captions are inside the H.264 bitstream. Reading them takes a
bitstream scan, so it is a separate stage plus a source stage.

| Content        | Load                         |
| -------------- | ---------------------------- |
| MPEG-TS        | `ts-transmux`, `text-cea608` |
| Fragmented MP4 | `nal-scan`, `text-cea608`    |

```ts
import nalScan from 'mattebox/stages/nal-scan';
import textCea608 from 'mattebox/stages/text-cea608';

const engine = mattebox({ stages: [hlsCmaf(), nalScan(), textCea608()] });
```

The caption track appears on the element as `CC1`, hidden until the viewer
turns it on. If your packager can emit WebVTT sidecars instead, skip these
stages.

## ID3 metadata

ID3 tags in MPEG-TS or packed-audio segments become cues on a metadata
`TextTrack`. The stage requires `ts-transmux` or `packed-audio`.

```ts
import tsTransmux from 'mattebox/containers/ts-transmux';
import metaId3 from 'mattebox/stages/meta-id3';

const engine = mattebox({ stages: [hlsCmaf(), tsTransmux(), metaId3()] });

video.textTracks.addEventListener('addtrack', ({ track }) => {
  if (track.kind !== 'metadata') return;
  track.mode = 'hidden';
  track.addEventListener('cuechange', () => console.log(track.activeCues));
});
```

## Example

An HLS player with a language menu and a subtitle menu.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import altAudio from 'mattebox/stages/alt-audio';
import codecSwitch from 'mattebox/stages/codec-switch';
import textWebvtt from 'mattebox/stages/text-webvtt';
import textWebvttSegmented from 'mattebox/stages/text-webvtt-segmented';

const engine = mattebox({
  stages: [hlsCmaf(), codecSwitch(), altAudio(), textWebvtt(), textWebvttSegmented()],
});

function fill(select, contentType) {
  select.replaceChildren();
  for (const track of engine.tracks.available) {
    if (track.contentType !== contentType) continue;
    const selected = engine.tracks.active(contentType)?.id === track.id;
    select.add(new Option(track.lang ?? track.id, track.id, false, selected));
  }
}

engine.on('tracks:changed', () => {
  fill(audioMenu, 'audio');
  fill(subtitleMenu, 'text');
});
audioMenu.onchange = () => engine.tracks.select(audioMenu.value);
subtitleMenu.onchange = () => engine.tracks.select(subtitleMenu.value);
```

Next: [07 DRM](07-drm.md).
