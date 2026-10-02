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

The captions are a text track like any subtitle, with `role: 'caption'`
and `mimeType: 'application/cea-608'`. Select it with `engine.tracks`, and
a menu lists it.

- The manifest declares it: HLS `EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` with
  `INSTREAM-ID="CC1"`, or DASH `Accessibility` with
  `urn:scte:dash:cc:cea-608:2015`.
- A channel the manifest does not declare gets the track `cea608:CC1` to
  `cea608:CC4` when its first caption arrives, with a `tracks:changed` event.
- All four channels are decoded: CC1 and CC2 on field 1, CC3 and CC4 on
  field 2. CEA-708 services need `text-cea708` (next section).

On the element, each channel's cues go to a native caption track labelled
`CC1` to `CC4`. It
shows while the caption track is selected, and a pick in the browser's
caption menu selects it in the engine. If your packager can emit WebVTT
sidecars instead, skip these stages.

## CEA-708 captions

CEA-708 captions ride in the same video data as CEA-608. `text-cea708`
decodes them, with the same source stages as `text-cea608`. It is in
`full`; add it to another preset with `stages`.

```ts
import hls from 'mattebox/presets/hls';
import textCea708 from 'mattebox/stages/text-cea708';

const engine = hls({ stages: [textCea708()] });
```

Each service is a text track with `role: 'caption'` and `mimeType:
'application/cea-708'`.

- The manifest declares it: HLS `INSTREAM-ID="SERVICE1"` to `"SERVICE63"`,
  or DASH `Accessibility` with `urn:scte:dash:cc:cea-708:2015`.
- A service the manifest does not declare gets the track `cea708:SERVICEn`
  when its first caption arrives.
- A stream that carries both formats lists the 608 channels and the 708
  services side by side. Your menu decides which to offer.

Each visible caption window becomes a cue on a native caption track
labelled `SERVICE1` to `SERVICE63`. The cue sits where the window sits:
its anchor sets `line` and `position`, its width sets `size`, and its
justification sets `align`. Italics and underline show. Colors, edges, and
fonts do not: a `VTTCue` carries no color without page CSS. Each cue keeps
the window layout in a `cea708` property, for a player that draws captions
itself.

## Timed metadata

The `timed-metadata` stage collects timed metadata from every source into
one list. It is in `full`; add it to another preset with `stages`.

| Source                 | Where it comes from                         |
| ---------------------- | ------------------------------------------- |
| HLS `EXT-X-DATERANGE`  | The media playlists, merged by `ID`         |
| DASH `EventStream`     | The MPD, per period                         |
| DASH and CMAF `emsg`   | The fMP4 segments, versions 0 and 1         |
| ID3 in MPEG-TS         | The stream of type 0x15, with `ts-transmux` |
| ID3 metadata rendition | `application/id3` segments, with `meta-id3` |

```ts
import hls from 'mattebox/presets/hls';
import timedMetadata from 'mattebox/stages/timed-metadata';

const engine = hls({ stages: [timedMetadata()] });

engine.on('metadata:enter', ({ id }) => {
  const event = engine.metadata.events.find((e) => e.id === id);
  if (event?.scte35?.outOfNetwork) showAdBadge(event.end);
});
engine.on('metadata:exit', ({ id }) => hideAdBadge(id));
```

`engine.metadata.events` lists every record of the current source, sorted
by `start`. `engine.metadata.at(time)` returns the records that span `time`.

- `start` and `end` are presentation seconds. `end` equals `start` for an
  instant, and is `null` while a span is open, such as a splice out with no
  in yet.
- `attributes` holds a date range's attributes as written, `X-` ones
  included.
- `data` holds the bytes: the SCTE-35 section, the emsg message, the Event
  body, or the ID3 tag. `frames` holds the decoded ID3 frames.
- `scte35` summarizes an SCTE-35 section: the command type, the event id,
  the out-of-network flag, the break duration, and each segmentation's type
  and duration.

The stage emits three events, each with the record's `id`:

| Event            | When                                             |
| ---------------- | ------------------------------------------------ |
| `metadata:added` | A record appears, or a later sighting changes it |
| `metadata:enter` | The playhead reaches its start                   |
| `metadata:exit`  | The playhead passes its end                      |

Playback across an instant emits `enter` and then `exit`. A seek emits
`exit` for the spans it leaves and `enter` for the spans it lands in, and
skips the instants in between.

The stage also writes every record as a cue on a native `metadata` text
track labelled `metadata`, with the record as JSON in the cue text. Use it
when your page already reads `textTracks`.

The stage does not play HLS interstitials. Their date ranges are records
like any other, with `X-ASSET-URI` in `attributes`.

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
