# 15 Chapters

This chapter covers chapters: named spans of the presentation that a menu or
a seek bar shows.

## engine.chapters

Chapters come from the manifest or from a file you load. The stage fetches
both through the transport, so request hooks such as authentication headers
and CMCD apply.

```ts
import chapters from 'mattebox/stages/chapters';

const engine = mattebox({ stages: [hlsCmaf(), chapters()] });

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');
await engine.chapters.load('https://example.com/vod/chapters.vtt');

const chapter = engine.chapters.at(video.currentTime);
// { id, start, end, title, lang?, image?, data? } or null
```

| Member      | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `load(url)` | Fetches and parses a chapters file. Resolves to the chapter count |
| `at(time)`  | The chapter covering a presentation time, or null                 |
| `all`       | Every chapter, in start order                                     |
| `source`    | `'none'`, `'app'`, or `'manifest'`                                |

A file you load wins over the manifest's chapters. Load it after
`engine.load`. Every `load`, `unload`, and `detach` empties both lists, so
chapters never carry over to the next source.

| Event              | Payload                | When                                                              |
| ------------------ | ---------------------- | ----------------------------------------------------------------- |
| `chapters:changed` | `{ count, source }`    | The list is replaced or emptied                                   |
| `chapters:warning` | `{ url, reason, id? }` | An entry was skipped, truncated, or not JSON, or the fetch failed |

## From the manifest

An HLS multivariant playlist names a chapters document with session data.
The stage fetches it once per load, with no call from you.

```
#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.chapters",URI="chapters.json"
```

The document is Apple's JSON chapters format, the one Safari and Apple TV
read. You can also pass such a file to `load`.

```json
[
  {
    "chapter": 1,
    "start-time": 0,
    "duration": 24,
    "titles": [
      { "language": "en", "title": "Opening" },
      { "language": "fr", "title": "Ouverture" }
    ],
    "images": [
      { "image-category": "thumbnail", "pixel-width": 320, "pixel-height": 180, "url": "at-0.jpg" }
    ]
  }
]
```

| Field        | Becomes                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `start-time` | `start`; an entry without it is skipped                                      |
| `duration`   | `end = start + duration`; without it, the next chapter's start               |
| `titles`     | `title` and `lang`: the active subtitle language, else `und`, else the first |
| `images`     | `image`: the first one; image URLs resolve against the document              |
| `chapter`    | `id`                                                                         |
| all of them  | `data`, with every title, image, and metadata item                           |

The last chapter without a `duration` ends where the presentation ends.
Chapters that overlap are cut at the next chapter's start, with a
`chapters:warning`. DASH has no chapters convention; load a file instead.

You read every session-data entry, chapters or not, from
`engine.stats.snapshot().presentation?.sessionData`.

## A chapters track

A standard WebVTT chapters file. Each cue's text is the chapter title. The
browser's `<track kind="chapters">` reads the same file.

```
WEBVTT

00:00:00.000 --> 00:01:00.000
A morning in the meadow

00:01:00.000 --> 00:03:25.000
The rodents
```

- A cue id becomes the chapter `id`.
- A gap between chapters stays a gap.
- A chapter that runs into the next is cut at the next one's start.

## A metadata track

A cue's text may instead be a JSON object with a title, an image, and any
data you need. Mattebox defines this format. Other players read it as a
chapters track whose titles are raw JSON, so give it to the engine, or to
the element as `kind="metadata"`.

```
WEBVTT

rodents
00:01:00.000 --> 00:03:25.000
{ "title": "The rodents", "image": "images/rodents.jpg", "cast": ["Frank"] }

00:03:25.000 --> 00:05:20.000
{ "title": "The butterfly", "image": { "url": "images/butterfly.jpg", "width": 320, "height": 180 } }
```

| Field         | Becomes                                            |
| ------------- | -------------------------------------------------- |
| `title`       | `title`; the empty string when missing             |
| `image`       | `image`: a URL string, or `{ url, width, height }` |
| `lang`        | `lang`                                             |
| anything else | `data`, verbatim                                   |

Image URLs resolve against the chapters file. JSON cues and plain cues mix
in one file. A cue whose JSON does not parse keeps its text as the title and
raises `chapters:warning`.

## Example

A chapter label that follows playback.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import chapters from 'mattebox/stages/chapters';

const engine = mattebox({ stages: [hlsCmaf(), chapters()] });

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');
await engine.chapters.load('https://example.com/vod/chapters.vtt');

video.addEventListener('timeupdate', () => {
  const chapter = engine.chapters.at(video.currentTime);
  label.textContent = chapter?.title ?? '';
});
```

Next: [16 Trick play](16-trick-play.md).
