# 21 Interstitials

This chapter covers breaks: clips such as ads or promotions that play in
the presentation's place and then hand it back. The `interstitials` stage
plays the breaks the stream signals and the ones your page schedules.

## The stage

```ts
import full from 'mattebox/presets/full';
import interstitials from 'mattebox/stages/interstitials';

const engine = full({ stages: [interstitials()] });

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');
engine.on('interstitials:break-start', ({ id }) => showAdLabel(id));
engine.on('interstitials:break-end', () => hideAdLabel());
```

- The stage is in no preset. Add it with `stages`.
- The stage is in no CDN bundle either, `full` included. The
  `@mattebox/player-ads` CDN bundle carries it for you.
- At a break the engine loads the asset in the presentation's place. After
  the break it loads the presentation again, at the resume point. Both are
  preloaded with three segments ahead, so the switch makes no request.
- The element's `currentTime` stays the browser's. During a break it is
  the asset's time. Read `engine.interstitials.primary` for the
  presentation's.

## What the stage reads

| Signal                                                                                                                                | Protocol   | What plays                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| `EXT-X-DATERANGE` with `CLASS="com.apple.hls.interstitial"`                                                                           | HLS        | `X-ASSET-URI`, or the assets of `X-ASSET-LIST`                |
| An alternative MPD event, insert or replace                                                                                           | DASH       | The MPD at `uri`, or the assets of a List MPD                 |
| `EXT-X-CUE-OUT` and `EXT-X-CUE-IN`, `EXT-OATCLS-SCTE35`                                                                               | HLS        | The stream itself                                             |
| `EXT-X-DATERANGE` with `SCTE35-OUT`                                                                                                   | HLS        | The stream itself                                             |
| An SCTE-35 `EventStream`                                                                                                              | DASH       | The stream itself                                             |
| An alternative MPD or SCTE-35 event in an `emsg`                                                                                      | DASH, CMAF | The same as in the MPD                                        |
| SVTA2053 ad creatives: an `EventStream` `urn:svta:advertising-wg:ad-creative-signaling`, or `X-AD-CREATIVE-SIGNALING` on a date range | Both       | The stream itself, with the creatives' beacons as `creatives` |
| `engine.interstitials.schedule()`                                                                                                     | Both       | The assets you give                                           |

- The DASH schemes are `urn:mpeg:dash:event:alternativeMPD:insert:2025`
  and `urn:mpeg:dash:event:alternativeMPD:replace:2025`.
- A SCTE-35 cue-out is an opportunity: the stream plays through it, and the
  stage reports its start, quartiles and end as a break. You can fill it
  with your own assets, as shown below.
- An MPD's `RequestParam` with `useMPDUrlQuery` carries the MPD URL's query
  to the ad server's request (ISO/IEC 23009-1 Annex I).

## What a SCTE-35 span is

A `time_signal` names what its span is in its segmentation descriptor's
`segmentation_type_id` (ANSI/SCTE 35). The stage gives each span that
role as `break.role`:

| Ids                                      | Role              |                                                      |
| ---------------------------------------- | ----------------- | ---------------------------------------------------- |
| 0x22, 0x30, 0x32, 0x34, 0x36, 0x44, 0x46 | `ad`              | A break, an ad, a placement opportunity, an ad block |
| 0x3C, 0x3E                               | `promo`           | A promotion                                          |
| 0x24                                     | `opening-credits` | No break: a player shows a skip intro                |
| 0x26                                     | `closing-credits` | No break: a player shows a skip credits              |
| 0x20                                     | `chapter`         | No break: a chapter                                  |

- A `splice_insert`, a cue-out, or a section without descriptors is an `ad`.
- The end ids, the programme's start and end, overlays, unscheduled events
  and the network's start and end are no span. The stage leaves them out.
- A credits or chapter span fires no break event and offers no
  opportunity. It is in `breaks` with its role, for a player to show.
- SCTE-35 sets no seek or skip rule. A player decides how a span the stream
  plays itself is shown.

## The rules

The stage applies the rules of HLS interstitials (Appendix D of
draft-pantos-hls-rfc8216bis) to every break, as hls.js does:

| Rule                       | HLS                         | DASH           | What happens                                                                                                              |
| -------------------------- | --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pre-roll                   | `CUE="PRE"`                 |                | Plays before the first frame                                                                                              |
| Post-roll                  | `CUE="POST"`                |                | Plays at the end                                                                                                          |
| Once                       | `CUE="ONCE"`                | `executeOnce`  | Plays once. A seek back does not play it again                                                                            |
| Resume point               | `X-RESUME-OFFSET`           | `returnOffset` | Where the presentation resumes, from the break's start                                                                    |
| Takes the timeline's place | `X-TIMELINE-OCCUPIES=RANGE` | replace        | The break replaces that span instead of adding time                                                                       |
| Playout limit              | `X-PLAYOUT-LIMIT`           | `maxDuration`  | The break ends there, mid-asset if it must                                                                                |
| No skip                    | `X-RESTRICT="SKIP"`         |                | No seek inside the break, and no `skip()` before `skipAfter`                                                              |
| No jump                    | `X-RESTRICT="JUMP"`         | `noJump`       | A seek past the break plays it first, then goes to the target                                                             |
| Skip after                 | `X-SKIP-CONTROL-OFFSET`     | `skipAfter`    | `skip()` works only after that many seconds of the asset                                                                  |
| Snap                       | `X-SNAP="OUT,IN"`           |                | The break starts at the segment boundary before its start, and the presentation returns at the one after its resume point |

- A break plays when playback crosses its start, or when a seek lands
  inside the span a replacing break covers.
- A seek past a break without `noJump` skips it.
- An asset or an asset list that fails is skipped, with a warning. A break
  never stops the presentation.
- After a post-roll, the presentation loads again at its end, paused, and
  `interstitials:ended` fires.
- Live, the broadcast resumes at the resume point. The same break in the
  reloaded presentation gives its time on the new timeline, since an HLS
  live reload restarts its clock. A resume point that left the window
  resumes at the live edge.

## engine.interstitials

| Member            | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `breaks`          | Every break, by start                                                      |
| `playing`         | `{ break, asset }` while a break plays, or null                            |
| `primary`         | The presentation's playhead: `currentTime`, `duration`, `seek(time)`       |
| `integrated`      | The same with the inserted breaks counted in, as a seek bar shows it       |
| `schedule(entry)` | Adds a break with your assets, or fills an opportunity under its `id`      |
| `cancel(id)`      | Removes a break that has not started                                       |
| `skip()`          | Ends the asset that plays when the break allows it. Returns whether it did |
| `ended`           | The presentation and its post-rolls are over                               |

A break has `id`, `source` (`'hls'`, `'dash'`, `'scte35'` or `'page'`),
`start`, `cue`, `once`, `assets`, `assetList`, `covers` (the seconds it
replaces, 0 when it inserts), `resumeOffset`, `playoutLimit`, `noSkip`,
`noJump`, `skipAfter`, `scte35` (the cue-out's SCTE-35 summary) and
`attributes` (as the stream wrote them). An asset has `url`, `duration`,
`mimeType` and `tracking`, the DASH callback beacons of a List MPD with
their offsets.

| Event                       | Payload                           | When                                                                                                                  |
| --------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `interstitials:changed`     | `{ breaks }`                      | A break was added, changed or removed                                                                                 |
| `interstitials:opportunity` | `{ id, break, duration }`         | A cue-out is known, before its start                                                                                  |
| `interstitials:break-start` | `{ id, break, stitched? }`        | A break starts. `stitched` when the stream plays it                                                                   |
| `interstitials:asset-start` | `{ id, break, asset, url }`       | An asset starts                                                                                                       |
| `interstitials:progress`    | `{ id, break, asset?, quartile }` | An asset or a cue-out reaches 25, 50 or 75 percent                                                                    |
| `interstitials:asset-end`   | `{ id, break, asset }`            | An asset ends, played or skipped                                                                                      |
| `interstitials:break-end`   | `{ id, break, resume? }`          | The presentation resumes                                                                                              |
| `interstitials:skipped`     | `{ id, asset }`                   | `skip()` ended an asset                                                                                               |
| `interstitials:ended`       | `{}`                              | The presentation is over, after its post-roll when it has one. A playlist moves on here, not at the element's `ended` |
| `interstitials:warning`     | `{ id, url?, reason }`            | An asset or an asset list failed                                                                                      |

The stage sends no beacon. A player sends the impression and quartile
beacons from these events and from each asset's `tracking`.

## Schedule your own breaks

Give the assets as manifest URLs, HLS or DASH. A progressive MP4 needs the
browser's own playback, so a player plays those around the engine.

```ts
engine.interstitials.schedule({
  start: 300,
  assets: [{ url: 'https://ads.example.com/promo/master.m3u8', duration: 15 }],
});

// Fill a cue-out of a live stream with your own ad.
engine.on('interstitials:opportunity', ({ id, break: entry, duration }) => {
  engine.interstitials.schedule({
    id,
    start: entry.start,
    covers: duration,
    assets: [{ url: `https://ads.example.com/fill.m3u8?duration=${duration}` }],
  });
});
```

## In the playground

The Diagnostics tab lists the breaks under Breaks, the one that plays in
bold, and the event log shows each event. The streams under "Ad insertion
and discontinuities" and the generated ones with interstitials add the
stage when you choose them.

## Example

A page that shows "Ad" during a break and keeps its seek bar on the
presentation's timeline:

```ts
import full from 'mattebox/presets/full';
import interstitials from 'mattebox/stages/interstitials';

const video = document.querySelector('video') as HTMLVideoElement;
const label = document.querySelector('#ad') as HTMLElement;
const bar = document.querySelector('#seek') as HTMLInputElement;
const engine = full({ stages: [interstitials()] });

engine.on('interstitials:break-start', () => {
  label.hidden = false;
  bar.disabled = true;
});
engine.on('interstitials:break-end', () => {
  label.hidden = true;
  bar.disabled = false;
});
video.addEventListener('timeupdate', () => {
  const timeline = engine.interstitials.integrated;
  bar.max = String(timeline.duration);
  bar.value = String(timeline.currentTime);
});
bar.addEventListener('change', () => engine.interstitials.integrated.seek(Number(bar.value)));

await engine.attach(video);
engine.load('https://example.com/vod/master.m3u8');
```
