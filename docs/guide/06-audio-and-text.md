# 06 Audio and text

This chapter covers track selection, alternate audio, subtitles, captions,
and timed metadata.

## engine.tracks

Every selectable stream is a track. Audio and video always have one
selected. Text and metadata can be deselected.

```ts
const t = engine.tracks;

t.available;          // every track the manifest declared
t.selectable('a:ac3'); // false when nothing here can play it
t.active('audio');    // the selected audio track, or null
t.select('audio:de'); // switch by track id
t.deselect('text');   // stop the subtitle pipeline and clear its cues
```

A track is listed but not selectable until a stage handles its content
type. Text tracks need a text stage. A track the browser cannot decode,
such as AC-3 audio in a browser without AC-3, is listed but not selectable
either. A menu lists the tracks `selectable` answers true for.

You label a track in a menu from these fields.

| Field             | Meaning                                              | HLS source        | DASH source                                               |
| ----------------- | ---------------------------------------------------- | ----------------- | --------------------------------------------------------- |
| `lang`            | Language tag                                         | `LANGUAGE`        | `@lang`                                                   |
| `role`            | `main` or `alternate` in HLS; the first role in DASH | `DEFAULT`         | first `Role`                                              |
| `roles`           | Every role, such as `main`, `dub`, `commentary`      | none              | every `Role`                                              |
| `characteristics` | Media characteristic tags, such as audio description | `CHARACTERISTICS` | `Accessibility` `AudioPurposeCS` 1 and 2, as the HLS tags |
| `forced`          | `true` on a forced-subtitle track                    | `FORCED=YES`      | `Role` `forced-subtitle`                                  |

The engine copies HLS `CHARACTERISTICS` as written, such as
`public.accessibility.describes-video` (audio description) or
`public.original-content` (original-language audio).

These functions answer from the standard tags and roles. A tag outside them
stays a string in `characteristics`, and you filter on it yourself.

| Function             | True for                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `isAudioDescription` | `public.accessibility.describes-video`                                                   |
| `isEnhancedSpeech`   | `public.accessibility.enhances-speech-intelligibility`                                   |
| `isSdh`              | `transcribes-spoken-dialog` with `describes-music-and-sound`, or the DASH role `caption` |
| `isOriginal`         | `public.original-content`                                                                |

```ts
import { isAudioDescription } from 'mattebox';

const described = engine.tracks.available.find(isAudioDescription);
```

A switch through `select` takes effect from the segment under the playhead:
the previous track is flushed from there and the new one refills it. A group
switch that follows a video rendition change lets the previous group play out
to a segment boundary ahead instead, so the switch never rebuffers.

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

## Forced subtitles

A forced subtitle track carries text the audio does not, such as translated
signs. The `forced-subtitles` stage shows it while no regular subtitle is
selected, Off included. It follows Apple's rule:

- It shows the forced track whose language matches the audio, then one
  whose primary language matches (`en` for `en-US`), then the first forced
  track.
- It switches the forced track when the audio language changes.
- A regular subtitle you select replaces it.
- It picks only a format a loaded stage plays.

Every preset includes it. To keep forced subtitles off, pass
`enabled: false`. To switch them at runtime, set
`engine.forcedSubtitles.enabled`.

```ts
import forcedSubtitles from 'mattebox/stages/forced-subtitles';

const engine = mattebox({
  stages: [hlsCmaf(), textWebvtt(), textWebvttSegmented(), forcedSubtitles({ enabled: false })],
});

engine.forcedSubtitles.enabled = true;
```

While a forced track shows, `engine.tracks.active('text')` returns it, with
`forced: true`. A subtitle menu lists the tracks without `forced` and shows
Off for a forced track.

## CEA-608 captions

CEA-608 captions are inside the video bitstream. `text-cea608` decodes them
and requires a source stage that finds them: `nal-scan` or `ts-transmux`.
Either one is enough. Every preset includes `nal-scan` and `text-cea608`.

| Content                       | Source stage  |
| ----------------------------- | ------------- |
| Fragmented MP4, H.264 or HEVC | `nal-scan`    |
| MPEG-TS, H.264                | `ts-transmux` |

Load both sources when a stream mixes TS and fMP4 renditions.

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
