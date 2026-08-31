# 11 Network and CDN

This chapter covers the transport: retries, request and response hooks,
replacing fetch, and the two CDN stages.

## Transport options

Every request the engine makes goes through one transport. Configure it on
`mattebox()`.

```ts
const engine = mattebox({
  stages: [hlsCmaf()],
  transport: {
    retry: { maxAttempts: 3, baseDelayMs: 500, factor: 2, maxDelayMs: 8000 },
    requestHooks: [(req) => { req.headers.Authorization = `Bearer ${token}`; }],
    responseHooks: [(res) => log(res.url, res.status, res.rtt)],
  },
});
```

| Option          | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `retry`         | Attempts, backoff, and which HTTP statuses retry                        |
| `requestHooks`  | Run before each request. May change the URL, headers, and timeout       |
| `responseHooks` | Run after each response with status, round-trip time, size, and outcome |
| `fetchImpl`     | Replaces `fetch` entirely                                               |

Request hooks see every request: manifests, segments, license requests,
steering manifests, thumbnail tracks. One hook adds auth everywhere.

## fetchImpl

`fetchImpl` replaces `fetch`. Use it in tests to limit bandwidth, delay
responses, or fail a URL.

```ts
const engine = mattebox({
  stages: [hlsCmaf(), abr()],
  transport: {
    fetchImpl: async (url, init) => {
      if (url.includes('segment-7')) return new Response(null, { status: 404 });
      return fetch(url, init);
    },
  },
});
```

## The cmcd stage

Common Media Client Data tells the CDN what the player is doing: the active
bitrate, the measured throughput, the buffer ahead, and the object type of
each request. The `cmcd` stage sends it as a query argument or as headers.

```ts
import cmcd from 'mattebox/stages/cmcd';

cmcd({ contentId: 'episode-42', mode: 'query', sessionId: crypto.randomUUID() });
```

| Option      | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `contentId` | A stable content id, sent as `cid`                                 |
| `mode`      | `query` appends a `CMCD` argument. `header` sends `CMCD-*` headers |
| `sessionId` | Overrides the generated session id                                 |

Headers need a CORS preflight. Use `query` unless your CDN prefers headers.

## The content-steering stage

Content steering lets a steering server move viewers between CDNs. HLS
declares pathways on variants, DASH on `BaseURL` elements. The stage handles
both, follows the steering manifest's priority order, and fails over when
the active pathway returns errors.

```ts
import contentSteering from 'mattebox/stages/content-steering';

const engine = mattebox({ stages: [hlsCmaf(), dashCmaf(), contentSteering()] });

engine.on('steering:failover', ({ from, to }) => console.log(`pathway ${from} -> ${to}`));
```

Nothing to configure. The steering server URL comes from the manifest.

## Example

A player that authenticates every request, reports CMCD, and follows
steering.

```ts
import { mattebox } from 'mattebox';
import hlsCmaf from 'mattebox/protocols/hls-cmaf';
import abr from 'mattebox/stages/abr';
import cmcd from 'mattebox/stages/cmcd';
import contentSteering from 'mattebox/stages/content-steering';

const engine = mattebox({
  stages: [hlsCmaf(), abr(), cmcd({ contentId: 'episode-42' }), contentSteering()],
  transport: {
    retry: { maxAttempts: 4 },
    requestHooks: [(req) => { req.headers.Authorization = `Bearer ${token}`; }],
  },
});
```

Next: [12 Diagnostics](12-diagnostics.md).
