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

## engine.live

Either adapter adds `engine.live`. It works the same for both protocols.

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

## The pdt stage

Program date time in HLS and `availabilityStartTime` in DASH anchor the
timeline to a wall clock. The `pdt` stage converts in both directions.

```ts
import pdt from 'mattebox/stages/pdt';

const engine = mattebox({ stages: [hlsCmaf(), hlsLive(), pdt()] });

const wall = engine.pdt.toWallClock(video.currentTime); // epoch seconds or null
const presentation = engine.pdt.toPresentationTime(Date.now() / 1000);
```

Use it to show a clock on the scrub bar or to seek to a broadcast time.

## The cmaf-timing stage

Some live CMAF packagers write the wall clock into each segment's `tfdt`,
so the segments land far past the playhead. The `cmaf-timing` stage
rewrites the decode time to the start time from the manifest. VOD content
is untouched.

```ts
import cmafTiming from 'mattebox/stages/cmaf-timing';

const engine = mattebox({ stages: [dashCmaf(), dashLive(), cmafTiming()] });
```

Every preset includes it. The symptom without it is a live stream that
buffers but never plays, and the manifest gives no hint. Load it in any
hand-built live stack too.

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
