# 05 Quality and ABR

This chapter covers rendition selection: what the kernel does, what the
`abr` stage adds, and how your app takes part.

## How selection works

Quality is a set of constraints, not a level index. Each source registers a
named constraint, the engine intersects them and picks from what is left.
Releasing one constraint does not affect the others.

| Who                 | Source name    | Registers                      |
| ------------------- | -------------- | ------------------------------ |
| Your quality menu   | Any name       | A pin or a cap                 |
| A data-saver toggle | Any name       | `maxBitrate`                   |
| `abr-cap-size`      | `element-size` | `maxHeight` from the element   |
| `abr`               | `abr`          | An emergency floor on collapse |
| `recovery`          | `recovery`     | Excluded rendition ids         |

Without `abr`, the engine plays the lowest allowed rendition and stays
there.

## engine.quality

```ts
const q = engine.quality;

q.renditions; // everything the manifest declared
q.allowed;    // after constraint intersection
q.active;     // the rendition being appended now
q.playing;    // the rendition decoding at currentTime
q.pinned;     // a rendition id, or null
q.constraints; // Map of source name to constraint
```

`active` and `playing` differ after a switch: the engine appends the new
rendition while the old one is still playing from the buffer. A quality
menu should show `playing`.

## Constraints

```ts
engine.quality.constrain('saver', { maxBitrate: 800_000 });
engine.quality.constrain('menu', { maxHeight: 720 });
engine.quality.release('saver');
```

| Field          | Effect                                 |
| -------------- | -------------------------------------- |
| `maxHeight`    | Drops renditions taller than this      |
| `maxWidth`     | Drops renditions wider than this       |
| `maxBitrate`   | Drops renditions above this bitrate    |
| `minBitrate`   | Drops renditions below this bitrate    |
| `maxFrameRate` | Drops renditions above this frame rate |
| `codecs`       | Keeps only these codec strings         |
| `excludeIds`   | Drops these rendition ids              |
| `hdr`          | Keeps HDR or SDR renditions            |

If the intersection is empty, the engine drops constraints newest first
until something is left, and emits `quality:constraints-unsatisfiable`.

## Pins

A pin forces one rendition. Pinning also disables ABR.

```ts
engine.quality.pin('v-1080', { apply: 'soon' });
engine.quality.auto(); // release the pin, ABR resumes
```

The `apply` option says when the change takes effect.

| Strategy | Behavior                                                   | Cost                                 |
| -------- | ---------------------------------------------------------- | ------------------------------------ |
| `next`   | At the next segment fetch                                  | None, latency equals buffer depth    |
| `soon`   | Abort in flight, replace from the next safe point, refetch | Usually invisible. The default       |
| `now`    | Flush from the playhead and refetch                        | A visible stall of about one segment |

## The abr stage

`abr` picks the rendition after constraints are applied. It uses two
throughput averages and the buffer level, and sets an emergency floor when
throughput collapses.

```ts
import abr from 'mattebox/stages/abr';

abr({
  safetyFactor: 0.7,     // fraction of the estimate a rendition may use
  upBufferSeconds: 8,    // buffer needed before switching up
  downBufferSeconds: 4,  // buffer below which a down-switch is immediate
});
```

Two more stages go with it.

| Stage          | Adds                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `abr-cap-size` | Caps height to the element's rendered size times the device pixel ratio               |
| `abr-persist`  | Remembers throughput across sessions so the first segment is not the lowest rendition |

`abr-persist` uses the storage you give it.

```ts
import abrPersist from 'mattebox/stages/abr-persist';

abrPersist({
  get: () => Number(localStorage.getItem('bps')) || null,
  set: (bps) => localStorage.setItem('bps', String(bps)),
});
```

## The codec-switch stage

Switching between renditions with different codecs needs either a
`changeType` call or a buffer reload. `codec-switch` checks what the browser
supports and picks. Without it, the engine treats identical codec strings as
seamless and reloads for anything else.

Load it whenever a ladder mixes codecs, or when `alt-audio` is loaded.

## Example

A quality menu that lists renditions, shows the one playing, and offers auto.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import abr from 'mattebox/stages/abr';
import abrCapSize from 'mattebox/stages/abr-cap-size';

const engine = mattebox({ stages: [hlsCmaf(), abr(), abrCapSize()] });

function renderMenu() {
  menu.replaceChildren();
  const auto = new Option('Auto', '', engine.quality.pinned === null);
  menu.add(auto);
  for (const r of engine.quality.renditions) {
    menu.add(new Option(`${r.height}p`, r.id, false, engine.quality.pinned === r.id));
  }
}

menu.onchange = () => {
  if (menu.value === '') engine.quality.auto();
  else engine.quality.pin(menu.value);
};

engine.on('tracks:changed', renderMenu);
video.addEventListener('timeupdate', () => {
  nowPlaying.textContent = `${engine.quality.playing?.height ?? '-'}p`;
});
```

Next: [06 Audio and text](06-audio-and-text.md).
