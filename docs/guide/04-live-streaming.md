# 04 Live streaming

This chapter covers the live adapters, the live edge, and wall-clock time.

## Live adapters

Each protocol has a live adapter that builds on its VOD adapter. Load both.

```ts
import dashCmaf from 'mattebox/protocols/dash-cmaf';
import dashLive from 'mattebox/protocols/dash-live';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import hlsLive from 'mattebox/protocols/hls-live';

const engine = mattebox({ stages: [hlsCmaf(), hlsLive(), dashCmaf(), dashLive()] });
```

A live manifest loaded without its live adapter plays what the first manifest
listed and then stops.

## What they do

| Adapter     | Behavior                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hls-live`  | Reloads the active playlists on the target-duration cadence. Reconciles the sliding window. Converts to VOD on `EXT-X-ENDLIST`                        |
| `dash-live` | Computes the window from `availabilityStartTime` and the wall clock. Corrects clock skew with `UTCTiming`. Refreshes the MPD on `minimumUpdatePeriod` |

Both refresh every active track, so audio and subtitles don't run dry while
the video keeps going.

`dash-live` reads the first `UTCTiming` element whose scheme it supports.

| Scheme                    | Where the server time comes from                    |
| ------------------------- | --------------------------------------------------- |
| `direct`                  | The `value` attribute, the time the MPD was written |
| `http-head`               | The `Date` header of a HEAD request to `value`      |
| `http-xsdate`, `http-iso` | The body of a GET request to `value`                |

A cross-origin `http-head` server must expose `Date` with
`Access-Control-Expose-Headers`. Without a time server, the client clock
counts as right.

Both loops stop on `engine.suspend()` and start again on `engine.resume()`.
The resume reloads every active playlist (or the MPD) before any segment is
scheduled, and the playhead rejoins at the live edge. See
[chapter 01](01-getting-started.md#suspend-and-resume).

## engine.live

Either adapter adds `engine.live`. It works the same for both protocols.
Its type is `LiveApi`, from `mattebox/protocols/hls-live` or
`mattebox/protocols/dash-live`.

| Member         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `edge`         | Where `seekToEdge()` lands, in presentation time      |
| `latency`      | Seconds between the availability end and the playhead |
| `atEdge`       | True within two seconds of the edge                   |
| `seekToEdge()` | Seeks to the edge                                     |

```ts
if ('live' in engine && !engine.live.atEdge) {
  goLiveButton.hidden = false;
}
goLiveButton.onclick = () => engine.live.seekToEdge();
```

A seek before the window start is clamped to the window start.

## Hold-back

The edge sits behind the end of the window by the hold-back. Playback
starts there.

| Source                                             | Hold-back                     |
| -------------------------------------------------- | ----------------------------- |
| HLS with `EXT-X-SERVER-CONTROL:HOLD-BACK`          | `HOLD-BACK`                   |
| HLS without it                                     | Three target durations        |
| LL-HLS through `hls-ll`, while the parts play      | `PART-HOLD-BACK`              |
| DASH through `dash-ll` with a `ServiceDescription` | `Latency@target`              |
| DASH with `@suggestedPresentationDelay`            | `@suggestedPresentationDelay` |
| DASH without it                                    | 10 seconds                    |

## Low-latency HLS

The `hls-ll` stage plays LL-HLS (RFC 8216bis). It contains `hls-cmaf` and
`hls-live`, so you load it in their place.

```ts
import hlsLl from 'mattebox/protocols/hls-ll';
import liveCatchup from 'mattebox/stages/live-catchup';

const engine = mattebox({ stages: [hlsLl(), liveCatchup()] });
```

The `hls-ll`, `dual-ll`, and `full` presets carry it.

| Feature                  | Tags                                        | Behavior                                                                     |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Parts                    | `EXT-X-PART`, `EXT-X-PART-INF`              | The newest segments play from their parts, as each part appears              |
| Preload hints            | `EXT-X-PRELOAD-HINT`                        | The next part is requested before it exists; the server answers when it does |
| Blocking playlist reload | `CAN-BLOCK-RELOAD`, `_HLS_msn`, `_HLS_part` | Each playlist answer asks at once for the next part                          |
| Delta updates            | `CAN-SKIP-UNTIL`, `EXT-X-SKIP`, `_HLS_skip` | Reloads ask for the newest part of the playlist only                         |
| Rendition reports        | `EXT-X-RENDITION-REPORT`                    | A quality switch loads the new playlist at its last part, without waiting    |
| Hold-back                | `PART-HOLD-BACK`                            | Playback starts and holds that far behind the end                            |

- A rendition switch, a seek, and the start land on a part marked
  `INDEPENDENT=YES`.
- A playlist without parts plays its whole segments at `HOLD-BACK`.
- A server that does not block gets its playlist reloaded on the target
  duration, as `hls-live` does.
- A segment keyed with `AES-128` plays whole, since the key covers the
  whole segment.
- A preload hint the server drops is no error.
- ABR measures a preload hint from its response headers on, so the time
  the server holds the request does not count as a slow link.

## Low-latency DASH

The `dash-ll` stage plays low-latency DASH (DASH-IF IOP low-latency
modes). It contains `dash-cmaf` and `dash-live`, so you load it in their
place.

```ts
import dashLl from 'mattebox/protocols/dash-ll';
import liveCatchup from 'mattebox/stages/live-catchup';

const engine = mattebox({ stages: [dashLl(), liveCatchup()] });
```

The `dash-ll`, `dual-ll`, and `full` presets carry it.

| Feature          | MPD signal                                         | Behavior                                                |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Early requests   | `SegmentTemplate@availabilityTimeOffset`           | A segment is requested that many seconds before it ends |
| Chunked segments | `SegmentTemplate@availabilityTimeComplete="false"` | Each `moof` and `mdat` pair appends as it arrives       |
| Target latency   | `ServiceDescription` `Latency@target`              | Playback starts and holds that far behind the end       |
| Catch-up bounds  | `ServiceDescription` `PlaybackRate`, `Latency@max` | `live-catchup` uses them where you set no option        |

- ABR measures a chunked segment only while a chunk arrives. The pauses
  between chunks are the encoder's, not the link's.
- A chunk that arrives in one read gives no measurement, and the estimate
  holds.
- An MPD without these signals plays as `dash-cmaf` and `dash-live` play
  it.
- The `dash` presets do not request early, since they read each segment
  whole: a segment requested early would take as long as the encoder.

## Live catch-up

The `live-catchup` stage holds a target latency. Without it, a stream that
stalls once stays that much further behind the edge.

- Behind the target, playback speeds up, up to `maxRate`.
- Closer than the target, playback slows down, down to `minRate`.
- With less than `minBuffer` seconds buffered ahead, it does not speed up.
- Past `maxLatency`, it seeks to the edge.
- After you seek or resume past `maxLatency`, it stands down. It holds the
  target again once playback is back near the edge, for example after
  `engine.live.seekToEdge()`.
- A rate your page sets wins. The stage leaves the rate alone until it is
  1 again.

| Option          | Default                                     | Meaning                                                  |
| --------------- | ------------------------------------------- | -------------------------------------------------------- |
| `targetLatency` | The hold-back                               | Seconds behind the live edge to hold                     |
| `minRate`       | The manifest's, else 0.96                   | The slowest rate                                         |
| `maxRate`       | The manifest's, else 1.04                   | The fastest rate                                         |
| `tolerance`     | 0.2                                         | Seconds of error before the rate changes                 |
| `maxLatency`    | The manifest's, else three times the target | Seconds of latency past which it seeks to the edge       |
| `minBuffer`     | 0.5                                         | Seconds of buffer ahead below which it does not speed up |

It adds `engine.catchup`.

| Member         | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `target`       | The latency it holds, in seconds, or null when nothing live plays |
| `latency`      | Seconds from the moving edge to the playhead, or null             |
| `rate`         | The rate it set last; 1 while it does not act                     |
| `active`       | True while it holds the target                                    |
| `setTarget(s)` | Sets the target; null returns to the hold-back                    |

`engine.catchup.latency` counts the time since the window last moved, up
to one refresh period. `engine.live.latency` counts to the window end the
last playlist reported.

| Event          | Payload                     |
| -------------- | --------------------------- |
| `catchup:rate` | `{ rate, latency, target }` |
| `catchup:seek` | `{ latency, target }`       |

A speed menu reads `video.playbackRate`, so it shows the catch-up rate.
Compare with `engine.catchup.rate` to tell the two apart.

## The pdt stage

Program date time in HLS and `availabilityStartTime` in DASH anchor the
timeline to a wall clock. The `pdt` stage converts in both directions.
Every preset includes it.

```ts
import pdt from 'mattebox/stages/pdt';

const engine = mattebox({ stages: [hlsCmaf(), hlsLive(), pdt()] });

const wall = engine.pdt.toWallClock(video.currentTime); // epoch seconds or null
const presentation = engine.pdt.toPresentationTime(Date.now() / 1000);
```

Use it to show a clock on the scrub bar or to seek to a broadcast time.

## The cmaf-timing stage

Packagers write whatever clock they like into each segment's `tfdt`: a
live packager writes the wall clock, and some VOD packagers start the
media clock seconds after zero. Without correction the segments land away
from the playhead. The `cmaf-timing` stage reads where each segment's
media clock starts, and the kernel sets the SourceBuffer `timestampOffset`
that lands the segment at its manifest time. It sets one offset per
timeline, from the first video segment, and applies it to audio too, so
the tracks keep the alignment their shared clock gives them. The bytes are
never rewritten.

```ts
import cmafTiming from 'mattebox/stages/cmaf-timing';

const engine = mattebox({ stages: [dashCmaf(), dashLive(), cmafTiming()] });
```

Every preset includes it. The symptom without it is a stream that buffers
but never plays, or plays a few seconds and stalls, and the manifest gives
no hint. Load it in any hand-built stack.

## The recovery stage

Live streams fail more often than VOD: stale segments, CDN errors, stalls at
discontinuities. Load `recovery` on every live stack.
[Chapter 09](09-events-and-errors.md) describes what it does.

## Example

A live player with a "go live" button and a latency readout.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import hlsLive from 'mattebox/protocols/hls-live';
import pdt from 'mattebox/stages/pdt';
import recovery from 'mattebox/stages/recovery';

const video = document.querySelector('video');
const engine = mattebox({ stages: [hlsCmaf(), hlsLive(), pdt(), recovery()] });

await engine.attach(video);
engine.load('https://example.com/channel/master.m3u8');

video.addEventListener('timeupdate', () => {
  const latency = engine.live.latency;
  readout.textContent = latency === null ? '' : `${latency.toFixed(1)}s behind`;
  goLive.disabled = engine.live.atEdge;
});
goLive.onclick = () => engine.live.seekToEdge();
```

Next: [05 Quality and ABR](05-quality-and-abr.md).
