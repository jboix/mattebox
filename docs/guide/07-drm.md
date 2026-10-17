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
| `certificateUrl`      | The FairPlay certificate, when the `eme-fairplay` stage has none     |
| `licenseUrls`         | A server per key system, keyed by name such as `com.widevine.alpha`  |
| `requestFilter`       | Rewrites the license request body, URL and headers; may be async     |
| `responseFilter`      | Rewrites the license response before the key system reads it         |
| `getLicense`          | Gets the license itself, in place of the built-in request            |
| `getCertificate`      | Gets the server certificate for a key system                         |
| `onUnauthorized`      | Called once on a 401 or 403, so you can refresh a token              |
| `licenseRetry`        | Retries and timeout of a license request                             |
| `preferredKeySystems` | The order to try; key systems not listed come after the listed ones  |
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

`setLicenseUrls` replaces the map of servers per key system. An entry for
the active key system wins over the single URL. An empty map clears it.

```ts
engine.drm.setLicenseUrls({
  'com.widevine.alpha': 'https://license.example.com/widevine?token=abc',
  'com.microsoft.playready': 'https://license.example.com/playready?token=abc',
});
```

A new URL applies to the next license request. The keys the video holds
stay valid, so playback continues.

License requests go through the transport, so the request hooks from
[chapter 11](11-network-and-cdn.md) apply to them.

## Tokens

`requestFilter` and `responseFilter` can return a promise. The third
argument of `requestFilter` holds the `url` and `headers` of this request,
which you can change. When the server answers 401 or 403, `eme-core` calls
`onUnauthorized` once and sends the request again.

This Widevine example gets a bearer token from your token service and
gets a new one when the license server rejects the old one.

```ts
let token = await fetchToken();

emeCore({
  licenseUrls: { 'com.widevine.alpha': 'https://license.example.com/widevine' },
  requestFilter: async (body, keySystem, request) => {
    request.headers.Authorization = `Bearer ${token}`;
    return body;
  },
  onUnauthorized: async () => {
    token = await fetchToken();
  },
});
```

A second 401 or 403 after the refresh fails with `DRM_LICENSE_FAILED`.

## Your own license request

`getLicense` replaces the built-in request. It gets the CDM message and
returns the license bytes for `MediaKeySession.update`. Use it when your
server needs a body or a transport that a filter cannot express.

```ts
emeCore({
  getLicense: async (message, { keySystem, sessionId, initData, attempt }) => {
    const response = await fetch('https://license.example.com/widevine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: message,
    });
    if (!response.ok) throw Object.assign(new Error('license'), { status: response.status });
    return new Uint8Array(await response.arrayBuffer());
  },
});
```

A rejection with a `status` follows the HTTP rules below. A rejection
without one retries as a network error.

## Retries

`eme-core` sends a failed license request again with the defaults of the
hls.js key-load policy.

| `licenseRetry` field | Default    | Meaning                                               |
| -------------------- | ---------- | ----------------------------------------------------- |
| `errorRetries`       | 8          | Retries after a network error or a status outside 4xx |
| `timeoutRetries`     | 1          | Retries after a timeout                               |
| `timeoutMs`          | 20000      | Milliseconds to wait for the response headers         |
| `delayMs`            | 1000       | Milliseconds before a retry                           |
| `maxDelayMs`         | 20000      | The longest delay                                     |
| `backoff`            | `'linear'` | `'exponential'` doubles the delay at each retry       |

- A 4xx never retries. A 401 or 403 calls `onUnauthorized` first, as
  described in "Tokens".
- An error in your filter or in `getLicense` code that is not a request
  failure does not retry.
- After the last retry, the engine emits `DRM_LICENSE_FAILED` with the last
  reason.

## License renewal

`eme-core` renews a license when a key expires. It opens a new session with
the same init data, sends a new license request, and closes the old session
once the new key is usable. Playback continues when the new key arrives.

- Renewal waits for playback. A key that expires while the element is paused
  or the engine is suspended renews on the next `play` event.
- A renewal message the CDM sends on its own, such as Widevine's
  `license-renewal`, goes to the same license server.
- A renewal takes the same path as the first license: your filters,
  `getLicense`, the retries and the token refresh apply.
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

## FairPlay

FairPlay needs the application certificate from your key server. Pass its
URL as `certificateUrl`. `eme-core` fetches it before the first session.

```ts
emeFairplay({ certificateUrl: 'https://license.example.com/fairplay.cer' });
```

A player that builds its stages from a preset can pass the certificate to
`eme-core` instead, as `certificateUrl` or at runtime:

```ts
engine.drm.setCertificateUrl('https://license.example.com/fairplay.cer');
```

You can get the certificate yourself with `getCertificate` instead, for
example when the request needs a token. It also sets a Widevine service
certificate. Return null to leave a key system without one. A failed
certificate fails that key system, and `eme-core` tries the next.

```ts
emeCore({
  licenseUrls: { 'com.apple.fps': 'https://license.example.com/fairplay' },
  getCertificate: async (keySystem) => {
    if (keySystem !== 'com.apple.fps') return null;
    const response = await fetch('https://license.example.com/fairplay.cer', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return new Uint8Array(await response.arrayBuffer());
  },
  requestFilter: async (spc, keySystem, request) => {
    request.headers.Authorization = `Bearer ${token}`;
    return spc;
  },
  onUnauthorized: async () => {
    token = await fetchToken();
  },
});
```

Key servers differ in the license request body they accept.

| `licenseBody`      | Sends                                                         |
| ------------------ | ------------------------------------------------------------- |
| `binary` (default) | The SPC bytes, as `application/octet-stream`                  |
| `form`             | An `spc=` field with the SPC in base64, as a URL-encoded form |

FairPlay HLS in MPEG-TS uses SAMPLE-AES. Only Safari's own player decrypts
it, so it plays through native HLS (see "DRM without the engine" below),
not through the engine. FairPlay in fMP4 (`cbcs`) plays through both.

## ClearKey

ClearKey needs no server. Give the stage the keys and it answers license
requests itself. It also works in headless browsers, so it is the one to
test with.

```ts
emeCore({ clearKeys: { nrQFDeRLSAKTLifXUIPiZg: 'ABEiM0RVZneImaq7zN3u_w' } });
```

To use a ClearKey license server, name `org.w3.clearkey` in
`preferredKeySystems` or `licenseUrls`, and leave out `clearKeys`.

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

A license failure is fatal once the retries are spent. Output restrictions and expired keys carry their
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
