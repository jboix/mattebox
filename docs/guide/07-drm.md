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

| Option                | Meaning                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `licenseUrl`          | One server for every key system                                     |
| `licenseUrls`         | A server per key system, keyed by name such as `com.widevine.alpha` |
| `requestFilter`       | Rewrites the license request body, for auth tokens or wrapping      |
| `preferredKeySystems` | The order to try when the content offers several                    |
| `clearKeys`           | Key id to key, base64url, for ClearKey                              |

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
| `error`         | With category `drm` when a step fails                 |

A license failure is fatal. Output restrictions and expired keys carry their
own codes. [Chapter 09](09-events-and-errors.md) lists them.

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
