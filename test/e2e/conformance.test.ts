import { afterEach, expect, it } from 'vitest';
import { boot, disposeAll, play, sleep, until } from './harness.js';

// Public conformance streams: Apple's HLS examples and DASH-IF test vectors.
// Each test plays three seconds, and an on-demand stream also plays one
// second after a seek to 60 %. A stream whose codecs this browser does not
// decode is skipped. The streams live on third-party servers, so the
// nightly run reports them and never blocks a release.
// `scripts/conformance-table.mjs` turns the JSON report into the table in
// docs/guide/18-conformance.md.

afterEach(disposeAll);

interface Vector {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** The lowest video codec the stream offers, with its audio. */
  readonly codecs: string;
  readonly live?: boolean;
  /** MPEG-TS segments: load the legacy container family. */
  readonly ts?: boolean;
}

const VECTORS: readonly Vector[] = [
  {
    id: 'apple-fmp4',
    label: 'Apple advanced example, fMP4',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    codecs: 'avc1.640015,mp4a.40.2',
  },
  {
    id: 'apple-ts',
    label: 'Apple advanced example, MPEG-TS',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    codecs: 'avc1.640015,mp4a.40.2',
    ts: true,
  },
  {
    id: 'apple-hevc',
    label: 'Apple advanced example, HEVC and H.264',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8',
    codecs: 'avc1.64001f,mp4a.40.2',
  },
  {
    id: 'apple-bipbop-ts',
    label: 'Apple BipBop 16x9, MPEG-TS',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    codecs: 'avc1.4d400d,mp4a.40.2',
    ts: true,
  },
  {
    id: 'dashif-1a',
    label: 'DASH-IF 1a, on-demand H.264 baseline',
    url: 'https://dash.akamaized.net/dash264/TestCases/1a/netflix/exMPD_BIP_TC1.mpd',
    codecs: 'avc1.42401E,mp4a.40.5',
  },
  {
    id: 'dashif-2c',
    label: 'DASH-IF 2c, several resolutions',
    url: 'https://dash.akamaized.net/dash264/TestCases/2c/qualcomm/1/MultiResMPEG2.mpd',
    codecs: 'avc1.42c01f,mp4a.40.29',
  },
  {
    id: 'dashif-5a',
    label: 'DASH-IF 5a, H.264 main profile',
    url: 'https://dash.akamaized.net/dash264/TestCases/5a/nomor/1.mpd',
    codecs: 'avc1.4d401f,mp4a.40.29',
  },
  {
    id: 'dashif-switching',
    label: 'DASH-IF IOP adaptation set switching, H.264 and HEVC',
    url: 'https://dash.akamaized.net/dash264/TestCasesIOP33/adapatationSetSwitching/5/manifest.mpd',
    codecs: 'avc1.640028,mp4a.40.2',
  },
  {
    id: 'dashif-uhd-hevc',
    label: 'DASH-IF UHD, HEVC Main 10',
    url: 'https://dash.akamaized.net/dash264/TestCasesUHD/2b/11/MultiRate.mpd',
    codecs: 'hev1.2.4.L153.90,mp4a.40.2',
  },
  {
    id: 'dashif-last-segment',
    label: 'DASH-IF IOP last segment number',
    url: 'https://dash.akamaized.net/dash264/TestCasesIOP41/LastSegmentNumber/1/manifest_last_segment_num.mpd',
    codecs: 'avc1.640028,mp4a.40.2',
  },
  {
    id: 'dashif-periods',
    label: 'DASH-IF IOP periods that add and remove adaptation sets',
    url: 'https://dash.akamaized.net/dash264/TestCasesIOP33/multiplePeriods/2/manifest_multiple_Periods_Add_Remove_AdaptationSet.mpd',
    codecs: 'avc1.640028,mp4a.40.2',
  },
  {
    id: 'akamai-bbb',
    label: 'Akamai Big Buck Bunny, 30 fps ladder',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
    codecs: 'avc1.64000d,mp4a.40.5',
  },
  {
    id: 'axinom-clear',
    label: 'Axinom v7 test vector, clear',
    url: 'https://media.axprod.net/TestVectors/v7-Clear/Manifest.mpd',
    codecs: 'avc1.64001f,mp4a.40.2',
  },
  {
    id: 'livesim2',
    label: 'DASH-IF livesim2, live with $Number$',
    url: 'https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd',
    codecs: 'avc1.64001e,mp4a.40.2',
    live: true,
  },
  {
    id: 'livesim2-timeline',
    label: 'DASH-IF livesim2, live with SegmentTimeline',
    url: 'https://livesim2.dashif.org/livesim2/segtimeline_1/testpic_2s/Manifest.mpd',
    codecs: 'avc1.64001e,mp4a.40.2',
    live: true,
  },
  {
    id: 'livesim2-periods',
    label: 'DASH-IF livesim2, a new period every minute',
    url: 'https://livesim2.dashif.org/livesim2/periods_60/testpic_2s/Manifest.mpd',
    codecs: 'avc1.64001e,mp4a.40.2',
    live: true,
  },
];

for (const vector of VECTORS) {
  const decodes = MediaSource.isTypeSupported(`video/mp4; codecs="${vector.codecs}"`);
  it.skipIf(!decodes)(`conformance ${vector.id}: ${vector.label}`, async () => {
    const player = await boot({ url: vector.url, ...(vector.ts === true ? { ts: true } : {}) });
    await play(player, 3, 30_000);
    const { engine, video } = player;
    if (vector.live !== true) {
      const target = video.duration * 0.6;
      video.currentTime = target;
      await until(() => video.currentTime > target + 1, 'one second after the seek', 30_000);
    } else {
      await sleep(3_000);
    }
    expect(engine.error?.code ?? null).toBeNull();
  });
}
