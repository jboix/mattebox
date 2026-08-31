# 12 Diagnostics

This chapter covers stats, the trace, and replaying a trace.

## Stats

```ts
engine.stats.throughput; // measured throughput, bits per second
engine.stats.snapshot();  // the full kernel state, read-only
engine.stats.trace();     // the diagnostic ring buffer, oldest first
```

The snapshot holds the presentation, the buffers, the scheduling state, the
active tracks, the quality state, and the live window.

## The trace

Every message the engine handles, and the effects it produced, goes into a
ring buffer of 500 entries. Raise it with the `traceCapacity` config option.

Each entry has a timestamp, the message, the effects, and a digest of the
state after it. A stall on a viewer's TV comes with the exact sequence that
led to it.

Attach the trace to every error report.

```ts
import { exportTrace } from 'mattebox';

engine.on('error', (error) => {
  if (!error.fatal) return;
  send({ error, trace: exportTrace(engine.stats.trace()) });
});
```

`engine.error` already carries the trace for the last fatal error.

## Replay

The reducer is pure, so a trace can be replayed offline. Feed the recorded
messages into a fresh reducer and check that the same effects come out. If
not, the result points at the first entry where the current code disagrees.

```ts
import { createReducer, initialState, replay } from 'mattebox';

const result = replay(entries, createReducer([]), initialState({}));
if (!result.ok) {
  console.log('diverged at', result.divergedAt, result.expected, result.actual);
}
```

Build the reducer with the same stage slices as the engine that recorded the
trace.

## The playground

The hosted [playground](https://jboix.github.io/mattebox/) shows all of this
live: the trace, the buffered ranges per rendition, the quality constraints,
and a toggle per stage. Paste a manifest URL to try your own stream.

## Example

Log recovery actions and throughput, and export the trace on demand.

```ts
import { exportTrace, mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import abr from 'mattebox/stages/abr';
import recovery from 'mattebox/stages/recovery';

const engine = mattebox({ stages: [hlsCmaf(), abr(), recovery()], config: { traceCapacity: 2000 } });

for (const event of ['recovery:excluded', 'recovery:nudge', 'recovery:flush', 'recovery:skip']) {
  engine.on(event, (payload) => console.log(event, payload));
}

setInterval(() => {
  bandwidth.textContent = `${(engine.stats.throughput / 1_000_000).toFixed(1)} Mbit/s`;
}, 1000);

exportButton.onclick = () => {
  const blob = new Blob([exportTrace(engine.stats.trace())], { type: 'application/json' });
  window.open(URL.createObjectURL(blob));
};
```

Next: [13 Builds and targets](13-builds-and-targets.md).
