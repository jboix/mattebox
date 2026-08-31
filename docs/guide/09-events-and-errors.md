# 09 Events and errors

This chapter covers events, errors, and the `recovery` stage.

## Events

Subscribe with `on`. It returns the unsubscribe function.

```ts
const off = engine.on('playback:stalled', ({ at }) => console.log('stalled at', at));
off();
```

Media element events stay on the element. Subscribe to `timeupdate`,
`waiting`, `ended`, and the rest there.

| Event                               | Meaning                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `tracks:changed`                    | The set of available tracks changed                                                        |
| `tracks:selected`                   | A track was selected or deselected: `{ contentType, trackId }`, `trackId` null on deselect |
| `playback:stalled`                  | The decoder stopped inside buffered data, or `waiting` fired                               |
| `playback:ended`                    | The presentation reached its end                                                           |
| `quality:constraints-unsatisfiable` | Constraints were dropped to keep a playable rendition                                      |
| `quality:pin-unsatisfiable`         | A pinned rendition is not allowed                                                          |
| `quality:coupling-unsatisfiable`    | No rendition satisfies the active audio and text tracks                                    |
| `quota:exhausted`                   | Eviction could not free enough buffer                                                      |
| `command:rejected`                  | The reducer refused a command in the current state                                         |
| `recovery:*`                        | What the recovery stage did. See below                                                     |
| `drm:*`                             | Key system and key status. See [chapter 07](07-drm.md)                                     |
| `steering:failover`                 | The steering stage switched pathway                                                        |
| `codecprobe:detected`               | The probe read a codec string from an init segment                                         |
| `error`                             | Every error, fatal or not                                                                  |

## Errors

An error is a plain object with a category, a code, and two flags.

```ts
engine.on('error', (error) => {
  console.log(error.category, error.code, error.fatal, error.recoverable);
});
```

| Category   | Codes                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`  | `NETWORK_FAILED`, `NETWORK_TIMEOUT`, `NETWORK_HTTP_STATUS`, `NETWORK_ABORTED`                                                                                         |
| `manifest` | `MANIFEST_PARSE_FAILED`, `MANIFEST_UNSUPPORTED`, `MANIFEST_EMPTY`, `MANIFEST_REFRESH_FAILED`                                                                          |
| `media`    | `MEDIA_APPEND_FAILED`, `MEDIA_CONTAINER_INVALID`, `MEDIA_QUOTA_EXCEEDED`, `MEDIA_CODEC_UNSUPPORTED`, `MEDIA_DECODE_ERROR`, `MEDIA_SOURCE_CLOSED`                      |
| `drm`      | `DRM_KEY_SYSTEM_UNAVAILABLE`, `DRM_LICENSE_FAILED`, `DRM_KEY_EXPIRED`, `DRM_KEY_STATUS_ERROR`, `DRM_OUTPUT_RESTRICTED`, `DRM_SESSION_FAILED`, `DRM_INIT_DATA_INVALID` |
| `config`   | `CONFIG_INVALID`, `CONFIG_STAGE_REQUIREMENT_MISSING`, `CONFIG_ELEMENT_OCCUPIED`                                                                                       |
| `internal` | `INTERNAL_ASSERTION`                                                                                                                                                  |

`fatal` means playback halted. `recoverable` means the recovery stage could
act on it.

`MANIFEST_UNSUPPORTED` means no loaded adapter can parse the source: a
`mimeType` none of them handles (reported before any request), an audio or
video Content-Type on the manifest response, or bytes none of them
recognizes. A manifest fetch that fails after retries is fatal too, with its
network code. [Chapter 03](03-hls-and-dash.md) shows the fallback to native
playback.

## Fatal errors

A fatal error stops the engine and is kept on `engine.error` with the trace
attached. Show a message, log the trace, and call `load` again to retry.

```ts
engine.on('error', (error) => {
  if (!error.fatal) return;
  report(engine.error); // includes the trace
  showRetry();
});
```

The element's own `MediaError` is reported the same way, as
`MEDIA_DECODE_ERROR` or `MEDIA_CODEC_UNSUPPORTED`. The engine never restarts
on its own.

## The recovery stage

The kernel retries network requests. `recovery` handles what retries don't,
and every action it takes is in the trace.

| Situation                              | Action                                              | Event                                      |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| A segment fails twice on one rendition | Excludes the rendition, readmits it after a backoff | `recovery:excluded`, `recovery:readmitted` |
| A segment fails across renditions      | Seeks over the hole                                 | `recovery:skip`                            |
| A stall with data ahead                | Nudges the playhead                                 | `recovery:nudge`                           |
| A stall that a nudge did not fix       | Flushes from the playhead and refetches             | `recovery:flush`                           |
| A small gap in the buffer              | Jumps it                                            | `recovery:gap-jump`                        |

```ts
import recovery from 'mattebox/stages/recovery';

recovery({
  excludeAfter: 2,          // failures on one rendition before exclusion
  readmitAfterSeconds: 15,  // how long an excluded rendition sits out
  skipAfter: 3,             // failures across renditions before a skip
  maxGapSeconds: 2,         // largest hole a stall may jump
});
```

Load it in production. Skip it only when you would rather see the failure.

## Example

A player with a status line and a retry button.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import recovery from 'mattebox/stages/recovery';

const engine = mattebox({ stages: [hlsCmaf(), recovery()] });
let lastUrl = '';

engine.on('recovery:excluded', ({ renditionId }) => {
  status.textContent = `rendition ${renditionId} excluded`;
});
engine.on('error', (error) => {
  status.textContent = `${error.category}: ${error.code}`;
  retry.hidden = !error.fatal;
});
retry.onclick = () => engine.load(lastUrl);

function play(url) {
  lastUrl = url;
  engine.load(url);
}
```

Next: [10 Thumbnails](10-thumbnails.md).
