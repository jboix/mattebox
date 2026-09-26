# 16 Trick play

This chapter covers fast forward and rewind: scanning through the
presentation at a multiple of normal speed.

## engine.trick

```ts
import trickPlay from 'mattebox/stages/trick-play';

const engine = mattebox({ stages: [hlsCmaf(), trickPlay()] });

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');

engine.trick.setRate(8); // fast forward at 8x
engine.trick.setRate(-4); // rewind at 4x
engine.trick.setRate(1); // back to normal playback
```

| Member          | Meaning                                                      |
| --------------- | ------------------------------------------------------------ |
| `setRate(rate)` | Scans at `rate`: above 2 forward, below -2 backward; 1 stops |
| `rate`          | The rate in force: 1, above 2, or below -2                   |
| `available`     | True when the stream has an I-frame track to scan with       |

| Rate     | What plays                                                            |
| -------- | --------------------------------------------------------------------- |
| Above 2  | The I-frame track at that rate, muted                                 |
| Below -2 | The I-frame track, paused, stepping back `rate × 0.25` s every 250 ms |
| 1        | The normal stream, with the previous mute state and play state        |

Scanning is not playback speed. For a speed from 0 to 2, set
`video.playbackRate` yourself: the browser plays the normal stream at that
speed, with sound. `setRate` throws a `RangeError` for any rate from -2 to 2
other than 1.

A full stream cannot decode fast enough past a few times normal speed, and
the browser cannot play backwards. An I-frame track holds only frames that
decode on their own, so the engine switches to it for scanning. Without one,
`available` is false and `setRate` throws. Show your scan controls only when
`available` is true.

Scanning stops by itself at the live edge, at the start and the end of the
presentation, and when you load another source. It also stops when your
page plays, pauses, or sets `playbackRate` during a scan, such as from a
play button or a speed menu. The normal stream then plays in the state you
asked for.

| Event           | Payload            | When                                                                 |
| --------------- | ------------------ | -------------------------------------------------------------------- |
| `trick:started` | `{ rate }`         | Scanning starts                                                      |
| `trick:rate`    | `{ rate }`         | The rate changes, a step from 4 to 8 included; 1 when scanning stops |
| `trick:stopped` | `{ rate, reason }` | Scanning stops: `rate`, `edge`, `start`, `end`, `page`, or `load`    |

## Scrubbing

While the viewer drags the seek bar, the video can show the key frame under
the pointer. Call these from your seek bar's pointer events.

| Member            | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `scrubStart()`    | Switches to the I-frame track and pauses                                 |
| `scrubTo(time)`   | Shows the key frame at `time`; only the latest time waits for a seek     |
| `scrubEnd(time?)` | Seeks to `time`, returns to the normal stream, resumes if it was playing |
| `scrubbing`       | True between `scrubStart` and `scrubEnd`                                 |

`scrubStart` throws without an I-frame track. Without one, seek as the
pointer moves, as usual.

| Event                 | Payload    | When             |
| --------------------- | ---------- | ---------------- |
| `trick:scrub-started` | `{}`       | Scrubbing starts |
| `trick:scrub-ended`   | `{ time }` | Scrubbing ends   |

## Frame previews

`frameAt` decodes the key frame at a time from the I-frame track, for a
preview card. You decide what the card shows: this frame, a thumbnail tile
from `engine.thumbnails.at(time)`, or nothing.

```ts
const bitmap = await engine.trick.frameAt(time, { width: 320 });
if (bitmap !== null) canvas.getContext('2d').drawImage(bitmap, 0, 0);
```

| Resolves to null when                                                      |
| -------------------------------------------------------------------------- |
| The browser has no WebCodecs                                               |
| The stream has no I-frame track, or it is encrypted                        |
| The I-frame track is TS                                                    |
| The track's segments are still loading (the first call on HLS starts that) |
| A later call replaced this one                                             |

`previews` is false when `frameAt` can never answer for this source: no
WebCodecs, no I-frame track, encrypted content, TS I-frames, or a codec the
decoder refuses. TS and the codec show only in the media, so `previews` can
turn false after a `frameAt` call. Stop asking then, and show a tile.

The bitmap belongs to a small cache. Draw it; never close it.

## Where the I-frame track comes from

| Manifest | Source                                                          |
| -------- | --------------------------------------------------------------- |
| HLS      | `EXT-X-I-FRAME-STREAM-INF` playlists                            |
| DASH     | An AdaptationSet with the DASH-IF trickmode `EssentialProperty` |

The track appears in `engine.tracks.available` with `role: 'trick'`.
`engine.tracks.select` refuses it; only the trick-play stage selects it.

An HLS I-frame playlist points at the first frame of each fragment of the
normal stream. The stage rebuilds each one as a fragment holding that frame
for the whole segment, so the buffer has no gaps at a high rate.

## Example

Buttons for rewind, play, and fast forward.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import trickPlay from 'mattebox/stages/trick-play';

const engine = mattebox({ stages: [hlsCmaf(), trickPlay()] });

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');

rewind.addEventListener('click', () => engine.trick.setRate(-8));
play.addEventListener('click', () => engine.trick.setRate(1));
forward.addEventListener('click', () => engine.trick.setRate(8));

engine.on('trick:stopped', (payload) => {
  const { reason } = payload as { rate: number; reason: string };
  if (reason === 'edge') label.textContent = 'Live';
});
```

This is the last chapter. The [architecture document](../architecture.md)
covers how the engine is built, for writing your own stage.
