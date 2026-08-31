# Mattebox guide

Each chapter covers one topic and ends with a working example. Read them in
order the first time, then use the table.

| Chapter                                                       | You will learn                                        |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| [01 Getting started](01-getting-started.md)                   | Install, create an engine, attach, load, detach       |
| [02 Presets and stages](02-presets-and-stages.md)             | Stages, presets, size per preset                      |
| [03 HLS and DASH](03-hls-and-dash.md)                         | The protocol adapters                                 |
| [04 Live streaming](04-live-streaming.md)                     | The live adapters, the edge, latency, wall-clock time |
| [05 Quality and ABR](05-quality-and-abr.md)                   | Renditions, constraints, pins, the `abr` stage        |
| [06 Audio and text](06-audio-and-text.md)                     | Alternate audio, WebVTT, CEA-608, ID3 metadata        |
| [07 DRM](07-drm.md)                                           | ClearKey, Widevine, PlayReady, FairPlay               |
| [08 Legacy transport streams](08-legacy-transport-streams.md) | MPEG-TS, packed audio, and codec probing              |
| [09 Events and errors](09-events-and-errors.md)               | Events, error codes, the `recovery` stage             |
| [10 Thumbnails](10-thumbnails.md)                             | Scrub previews from a sprite-sheet track              |
| [11 Network and CDN](11-network-and-cdn.md)                   | Transport hooks, retries, CMCD, content steering      |
| [12 Diagnostics](12-diagnostics.md)                           | Stats, the trace, replay, the hosted playground       |
| [13 Builds and targets](13-builds-and-targets.md)             | The three build outputs, the modern build, TV targets |
| [14 CDN](14-cdn.md)                                           | Script tags from jsDelivr, pinning, integrity, ESM    |

The [architecture document](../architecture.md) covers the internals, for
writing your own stage.
