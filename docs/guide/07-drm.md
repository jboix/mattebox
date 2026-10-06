# 07 DRM

This chapter covers protected content through Encrypted Media Extensions.

## EME stages

| Stage          | Provides                                            |
| -------------- | --------------------------------------------------- |
| `eme-core`     | The EME handshake, session management, and ClearKey |
| `eme-cenc`     | Widevine and PlayReady over Common Encryption       |
| `eme-fairplay` | FairPlay Streaming on Safari                        |

`eme-core` is required by the other two. Load the key systems your content
uses.

```ts
import emeCenc from 'mattebox/stages/eme-cenc';
import emeCore from 'mattebox/stages/eme-core';
import emeFairplay from 'mattebox/stages/eme-fairplay';

const engine = mattebox({
  stages: [
    hlsCmaf(),
    dashCmaf(),
    emeCore({ licenseUrl: 'https://license.example.com/widevine' }),
    emeCenc(),
    emeFairplay({ certificateUrl: 'https://license.example.com/fairplay.cer' }),
  ],
});
```

## Init data

Init data comes from the manifest (`EXT-X-KEY`, `ContentProtection`) or from
the media, through the element's `encrypted` event. `eme-core` takes both
and opens one session per key id, whichever arrives first.

The protocol adapters always parse protection info, so adding DRM later
changes nothing there.

## License servers

| Option                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `licenseUrl`          | One server for every key system                                      |
| `licenseUrls`         | A server per key system, keyed by name such as `com.widevine.alpha`  |
| `requestFilter`       | Rewrites the license request body, for auth tokens or wrapping       |
| `preferredKeySystems` | The order to try when the content offers several                     |
| `clearKeys`           | Key id to key, base64url, for ClearKey                               |
| `releaseOnSuspend`    | Closes the key sessions on suspend and licenses them again on resume |

```ts
emeCore({
  licenseUrls: {
    'com.widevine.alpha': 'https://license.example.com/widevine',
    'com.microsoft.playready': 'https://license.example.com/playready',
    'com.apple.fps': 'https://license.example.com/fairplay',
  },
  requestFilter: (body, keySystem) => body,
});
```

The URL can change at runtime.

```ts
engine.drm.setLicenseUrl('https://license.example.com/widevine?token=abc');
```

License requests go through the transport, so the request hooks from
[chapter 11](11-network-and-cdn.md) apply to them.

## License renewal

`eme-core` renews a license when a key expires. It opens a new session with
the same init data, sends a new license request, and closes the old session
once the new key is usable. Playback continues when the new key arrives.

- Renewal waits for playback. A key that expires while the element is paused
  or the engine is suspended renews on the next `play` event.
- A renewal message the CDM sends on its own, such as Widevine's
  `license-renewal`, goes to the same license server.
- A license that arrives already expired reports `DRM_KEY_EXPIRED`. The
  engine does not request it again.

## Release on suspend

A rights server that limits concurrent streams counts a session as long as
it holds a license and renews it. With `releaseOnSuspend: true`,
`engine.suspend()` closes every key session and emits `drm:released` with
the number of sessions. `engine.resume()` requests the same licenses again.

```ts
emeCore({ licenseUrl, releaseOnSuspend: true });
```

The option is off by default: resume then waits for a license round trip
before encrypted media plays. Closing a temporary session stops its
renewals; how soon the server frees the stream depends on its license
duration.

## ClearKey

ClearKey needs no server. Give the stage the keys and it answers license
requests itself. It also works in headless browsers, so it is the one to
test with.

```ts
emeCore({ clearKeys: { nrQFDeRLSAKTLifXUIPiZg: 'ABEiM0RVZneImaq7zN3u_w' } });
```

## engine.drm and events

```ts
engine.drm.keySystem; // 'com.widevine.alpha' or null
engine.drm.sessions;  // [{ keyId, status }]
```

| Event           | When                                                  |
| --------------- | ----------------------------------------------------- |
| `drm:encrypted` | Init data arrived from the media                      |
| `drm:keysystem` | A key system was selected                             |
| `drm:keystatus` | A key's status changed, such as `usable` or `expired` |
| `drm:renewing`  | An expired license is being renewed, with `keyIds`    |
| `drm:released`  | Suspend closed the key sessions, with `sessions`      |
| `error`         | With category `drm` when a step fails                 |

A license failure is fatal. Output restrictions and expired keys carry their
own codes. [Chapter 09](09-events-and-errors.md) lists them.

## DRM without the engine

On Safari you can play HLS natively by setting `video.src`. The engine does
not run then, but encrypted content still needs a license. `attachEme`
from `mattebox/eme` runs the same `eme-core` and key-system code on the
element, without an engine.

```ts
import { attachEme } from 'mattebox/eme';
import emeFairplay from 'mattebox/stages/eme-fairplay';

const drm = attachEme(video, {
  keySystems: [emeFairplay({ certificateUrl: 'https://license.example.com/fairplay.cer' })],
  licenseUrl: 'https://license.example.com/fairplay',
  requestHook: (request) => {
    request.headers.Authorization = `Bearer ${token}`;
  },
});
video.src = 'https://cdn.example.com/stream.m3u8';

drm.on('drm:keysystem', () => console.log(drm.drm.keySystem));
drm.on('error', (error) => console.error(error.code));

// When the session ends:
drm.detach();
```

- Call `attachEme` before you set `src`, so no `encrypted` event is missed.
- It takes the `eme-core` options from the table above, except
  `releaseOnSuspend`. Call `detach()` and attach again instead.
- `keySystems` lists the key-system stages to offer. ClearKey needs none.
- `requestHook` rewrites the URL and headers of license and certificate
  requests. The engine's request hooks do not apply, since no engine runs.
- Init data comes only from the element's `encrypted` event.
- `drm.drm` is the same API as `engine.drm`. `drm.on` takes the events in
  the table above.
- `detach()` closes every key session and clears the element's MediaKeys.

The CDN bundles that carry DRM have it as `mattebox.attachEme`.

## Example

A protected DASH and HLS player with a status pill.

```ts
import { mattebox } from 'mattebox';
import dashCmaf from 'mattebox/protocols/dash-cmaf';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import emeCenc from 'mattebox/stages/eme-cenc';
import emeCore from 'mattebox/stages/eme-core';
import emeFairplay from 'mattebox/stages/eme-fairplay';

const engine = mattebox({
  stages: [
    hlsCmaf(),
    dashCmaf(),
    emeCore({
      licenseUrls: {
        'com.widevine.alpha': 'https://license.example.com/widevine',
        'com.apple.fps': 'https://license.example.com/fairplay',
      },
    }),
    emeCenc(),
    emeFairplay({ certificateUrl: 'https://license.example.com/fairplay.cer' }),
  ],
});

engine.on('drm:keysystem', () => {
  pill.textContent = engine.drm.keySystem.split('.').pop();
});
engine.on('error', (error) => {
  if (error.category === 'drm') pill.textContent = error.code;
});
```

Next: [08 Legacy transport streams](08-legacy-transport-streams.md).
