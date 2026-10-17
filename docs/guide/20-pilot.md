# 20 Pilot

This chapter shows how to try the engine on part of your audience, measure
it against the player you run today, and roll it back.

## Before you start

1. Pin the version: an exact npm version, or a versioned CDN URL. See
   [chapter 14](14-cdn.md).
2. Compare in a lab first. Play the same stream with each player in turn,
   in the same browser, and record the four figures below.
3. Keep your current player deployable. The pilot changes which player a
   session loads, nothing else.

## Split the sessions

Choose the player once per session, from a stable value such as a session
ID, so a viewer does not switch players between page loads.

```ts
const pilot = hashOf(sessionId) % 100 < pilotPercent;
const player = pilot ? await startMattebox(video, url) : await startCurrent(video, url);
report('session', { player: pilot ? 'mattebox' : 'current' });
```

Start with a few percent, on one platform. Widen it after a week with no
regression.

## Send the figures

The `qoe` stage measures startup, rebuffering, and quality switches in the
page. The `error` event gives the errors. Send both to your analytics; in
the examples, `report` is your analytics call.

```ts
import full from 'mattebox/presets/full';

const engine = full({ config: { traceCapacity: 200 } });

engine.on('qoe:metrics', (metrics) => report('qoe', metrics));
engine.on('error', (error) => {
  report('error', { code: error.code, category: error.category, fatal: error.fatal });
  // On a fatal error, the last trace entries say what led to it.
  if (error.fatal) report('trace', { entries: engine.stats.trace().slice(-50) });
});
setInterval(() => {
  const playing = engine.quality.playing;
  if (playing !== null && !video.paused) report('bitrate', { bitrate: playing.bitrate });
}, 10_000);
```

A trace entry is small: byte payloads are recorded as their length. Fifty
entries are a few kilobytes.

## Compare

Compute the same four figures for both players, from the same sessions
window.

| Figure         | From the engine                                                           | Compare with                                  |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| Startup time   | `startupTime` of the `startup` report; the median and the 95th percentile | The same span in your current player          |
| Rebuffer ratio | `rebufferDuration` over the time watched                                  | Waiting time over watched time                |
| Bitrate        | The mean of the `bitrate` reports                                         | The bitrate your player reports while playing |
| Error rate     | Sessions with a fatal error over sessions started                         | Sessions your player ended with an error      |

- Count startup from the same moment in both players: the load call, or
  the first play request when it is later.
- Count a stall only after the first frame, and never during a seek. The
  `qoe` stage counts it so.

## Roll back

Set the pilot share to 0. New sessions then load your current player.

Roll back when the pilot is worse than your current player on any figure
for two days in a row. As a start:

- the error rate is higher by more than half a percentage point;
- the 95th percentile startup time is 20 % slower;
- the rebuffer ratio is higher by more than 0.2 percentage points.

Set your own limits from your current player's spread from day to day.

When you report a problem, attach the trace entries. A trace replays into
a fresh engine as a test case; see [chapter 12](12-diagnostics.md).
