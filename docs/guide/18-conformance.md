# 18 Conformance

This chapter lists the public test streams the engine plays, and the
result in each browser.

## The streams

The set holds Apple's HLS examples, DASH-IF test vectors and livesim2
live streams, and two test streams from Akamai and Axinom. They are in
`test/e2e/conformance.test.ts`.

A stream passes when:

- it plays three seconds without an error;
- on demand, it plays one more second after a seek to 60 % of its
  duration;
- live, it plays three more seconds.

A stream whose codecs the browser does not decode is marked
"no decoder". Playwright's Chromium has no H.264 or HEVC decoder, so most
streams are marked so there.

## Run it

```sh
pnpm exec playwright install chromium firefox webkit
pnpm run test:conformance
```

The script runs the three browsers one after another and rewrites the
table below. The nightly end-to-end job runs the same set and shows the
table in its summary. A failure there never blocks a release: the streams
live on servers outside the project.

## Results

Known failures:

- Apple's HEVC example fails to decode in Playwright's WebKit on Linux
  (WebKitGTK), on its H.264 renditions too. hls.js 1.7.2 fails there the
  same way, so the cause is the browser build.

<!-- conformance:start -->

Run on 2026-10-16.

| Stream                                                  | Chromium   | Firefox | WebKit |
| ------------------------------------------------------- | ---------- | ------- | ------ |
| Apple advanced example, fMP4                            | no decoder | pass    | pass   |
| Apple advanced example, MPEG-TS                         | no decoder | pass    | pass   |
| Apple advanced example, HEVC and H.264                  | no decoder | pass    | fail   |
| Apple BipBop 16x9, MPEG-TS                              | no decoder | pass    | pass   |
| DASH-IF 1a, on-demand H.264 baseline                    | no decoder | pass    | pass   |
| DASH-IF 2c, several resolutions                         | no decoder | pass    | pass   |
| DASH-IF 5a, H.264 main profile                          | no decoder | pass    | pass   |
| DASH-IF IOP adaptation set switching, H.264 and HEVC    | no decoder | pass    | pass   |
| DASH-IF UHD, HEVC Main 10                               | no decoder | pass    | pass   |
| DASH-IF IOP last segment number                         | no decoder | pass    | pass   |
| DASH-IF IOP periods that add and remove adaptation sets | no decoder | pass    | pass   |
| Akamai Big Buck Bunny, 30 fps ladder                    | no decoder | pass    | pass   |
| Axinom v7 test vector, clear                            | no decoder | pass    | pass   |
| DASH-IF livesim2, live with $Number$                    | no decoder | pass    | pass   |
| DASH-IF livesim2, live with SegmentTimeline             | no decoder | pass    | pass   |
| DASH-IF livesim2, a new period every minute             | no decoder | pass    | pass   |

<!-- conformance:end -->
