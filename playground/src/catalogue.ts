/**
 * The full stage catalogue from docs 04 through 06, grouped by layer.
 * Implemented entries carry a factory; the rest render as unbuilt so the
 * checkbox list is also the roadmap.
 */
import packedAudio from '../../src/containers/packed-audio/index.js';
import tsTransmux from '../../src/containers/ts-transmux/index.js';
import type { Stage } from '../../src/index.js';
import dashPreset from '../../src/presets/dash/index.js';
import dashDrmPreset from '../../src/presets/dash-drm/index.js';
import dualPreset from '../../src/presets/dual/index.js';
import dualDrmPreset from '../../src/presets/dual-drm/index.js';
import dualTsPreset from '../../src/presets/dual-ts/index.js';
import dualTsDrmPreset from '../../src/presets/dual-ts-drm/index.js';
import fullPreset from '../../src/presets/full/index.js';
import hlsPreset from '../../src/presets/hls/index.js';
import hlsDrmPreset from '../../src/presets/hls-drm/index.js';
import hlsTsPreset from '../../src/presets/hls-ts/index.js';
import hlsTsDrmPreset from '../../src/presets/hls-ts-drm/index.js';
import kernelPreset from '../../src/presets/kernel/index.js';
import { localThroughputStorage } from '../../src/presets/storage.js';
import dashCmaf from '../../src/protocols/dash-cmaf/index.js';
import dashLive from '../../src/protocols/dash-live/index.js';
import hlsCmaf from '../../src/protocols/hls-cmaf/index.js';
import hlsLive from '../../src/protocols/hls-live/index.js';
import abr from '../../src/stages/abr/index.js';
import abrCapSize from '../../src/stages/abr-cap-size/index.js';
import abrPersist from '../../src/stages/abr-persist/index.js';
import aes128 from '../../src/stages/aes-128/index.js';
import altAudio from '../../src/stages/alt-audio/index.js';
import chapters from '../../src/stages/chapters/index.js';
import cmafTiming from '../../src/stages/cmaf-timing/index.js';
import cmcd from '../../src/stages/cmcd/index.js';
import codecProbe from '../../src/stages/codec-probe/index.js';
import codecSwitch from '../../src/stages/codec-switch/index.js';
import contentSteering from '../../src/stages/content-steering/index.js';
import emeCenc from '../../src/stages/eme-cenc/index.js';
import emeCore from '../../src/stages/eme-core/index.js';
import emeFairplay from '../../src/stages/eme-fairplay/index.js';
import metaId3 from '../../src/stages/meta-id3/index.js';
import mp4Box from '../../src/stages/mp4-box/index.js';
import nalScan from '../../src/stages/nal-scan/index.js';
import pdt from '../../src/stages/pdt/index.js';
import recovery from '../../src/stages/recovery/index.js';
import textCea608 from '../../src/stages/text-cea608/index.js';
import textWebvtt from '../../src/stages/text-webvtt/index.js';
import textWebvttSegmented from '../../src/stages/text-webvtt-segmented/index.js';
import thumbnails from '../../src/stages/thumbnails/index.js';
import trickPlay from '../../src/stages/trick-play/index.js';
import type { Requirement } from '../../src/types/stage.js';

export interface CatalogueEntry {
  readonly name: string;
  readonly layer: 'protocols' | 'containers' | 'stages';
  /** The stage's own `requires`, so the table never restates a dependency. */
  readonly requires: readonly Requirement[];
  /** Capability names the stage provides; a requirement can name one instead of a stage. */
  readonly provides: readonly string[];
  readonly factory: (() => Stage) | null;
}

/** An implemented entry: name, requirements, and capabilities come from the stage it builds. */
function built(layer: CatalogueEntry['layer'], factory: () => Stage): CatalogueEntry {
  const stage = factory();
  return {
    name: stage.name,
    layer,
    requires: stage.requires ?? [],
    provides: (stage.provides ?? []).filter((c): c is string => typeof c === 'string'),
    factory,
  };
}

export const CATALOGUE: readonly CatalogueEntry[] = [
  built('protocols', hlsCmaf),
  built('protocols', hlsLive),
  built('protocols', dashCmaf),
  built('protocols', dashLive),
  built('stages', pdt),
  built('containers', mp4Box),
  built('containers', codecProbe),
  built('containers', codecSwitch),
  built('containers', tsTransmux),
  built('containers', aes128),
  built('containers', cmafTiming),
  built('containers', packedAudio),
  built('stages', metaId3),
  built('stages', altAudio),
  built('stages', abr),
  built('stages', abrCapSize),
  built('stages', () => abrPersist(localThroughputStorage())),
  built('stages', textWebvtt),
  built('stages', textWebvttSegmented),
  built('stages', nalScan),
  built('stages', textCea608),
  built('stages', () => emeCore()),
  built('stages', emeCenc),
  built('stages', () => emeFairplay()),
  built('stages', recovery),
  built('stages', contentSteering),
  built('stages', cmcd),
  built('stages', thumbnails),
  built('stages', chapters),
  built('stages', trickPlay),
];

/**
 * The presets, by name, as stage-name lists: what the Composition tab offers
 * before "custom". Read from the preset modules themselves, so the playground
 * never restates what a preset contains.
 */
export const PRESETS: ReadonlyArray<{ name: string; stages: readonly string[] }> = [
  kernelPreset,
  hlsPreset,
  hlsDrmPreset,
  hlsTsPreset,
  hlsTsDrmPreset,
  dashPreset,
  dashDrmPreset,
  dualPreset,
  dualDrmPreset,
  dualTsPreset,
  dualTsDrmPreset,
  fullPreset,
].map((preset) => ({ name: preset.presetName, stages: preset.stages().map((s) => s.name) }));

/** A topic of the stream list: one foldable section in the Stream tab. */
export interface StreamTopic {
  readonly id: string;
  readonly title: string;
  /** One line on what the streams in it test. */
  readonly hint: string;
}

/** The stream list's sections, in display order. */
export const TOPICS: readonly StreamTopic[] = [
  {
    id: 'vod',
    title: 'HLS and DASH on demand',
    hint: 'the everyday case, one stream per packager',
  },
  {
    id: 'previews',
    title: 'Thumbnails and chapters',
    hint: 'hover the seek bar; open the chapter menu in the bar',
  },
  {
    id: 'trick',
    title: 'Fast forward and rewind',
    hint: 'HLS I-frame playlists and DASH trick-mode sets; use the ▶▶ menu next to the seek bar',
  },
  { id: 'live', title: 'Live', hint: 'sliding windows, DVR, go live' },
  {
    id: 'ads',
    title: 'Ad insertion and discontinuities',
    hint: 'stitched breaks, multi-period timelines',
  },
  { id: 'drm', title: 'DRM', hint: 'licenses from public test servers' },
  {
    id: 'local',
    title: 'Generated locally',
    hint: 'the E2E corpus from test/e2e/gen-streams.sh, served by the dev server',
  },
];

export interface StreamEntry {
  readonly label: string;
  readonly url: string;
  /** The `TOPICS` id of the section the stream sits in. */
  readonly topic: string;
  /** Short facts shown as badges, beyond the ones derived from the fields below. */
  readonly tags?: readonly string[];
  /** License server for encrypted demo streams; prefilled when the entry is chosen. */
  readonly licenseUrl?: string;
  /** Vendor name from the key-system selector, when one should be preferred. */
  readonly keySystem?: string;
  /** A WebVTT sprite-sheet thumbnail track, for the thumbnails stage. */
  readonly thumbnails?: string;
  /** A chapters file, for the chapters stage. */
  readonly chapters?: string;
}

/**
 * The corpus generated by `test/e2e/gen-streams.sh`. The dev server serves it
 * from its public dir, and the GitHub Pages workflow copies it next to the
 * built site, so the URLs hang off Vite's base path. `VITE_LOCAL_STREAMS=off`
 * drops the entries, for a build that ships without the corpus (the pull
 * request previews).
 */
const local = (path: string): string => `${import.meta.env.BASE_URL}streams/${path}`;

/** Chapter files from `test/fixtures/chapters`, served beside the corpus. */
const chapterFile = (name: string): string => `${import.meta.env.BASE_URL}chapters/${name}`;

const LOCAL_STREAMS: readonly StreamEntry[] =
  import.meta.env.VITE_LOCAL_STREAMS === 'off'
    ? []
    : [
        {
          label: 'h264, three rungs, two audio groups, subtitles',
          url: local('h264/master.m3u8'),
          topic: 'local',
        },
        {
          label: 'vp9, three rungs, two audio groups, subtitles',
          url: local('vp9/master.m3u8'),
          topic: 'local',
        },
        { label: 'h264, three rungs', url: local('h264-dash/manifest.mpd'), topic: 'local' },
        { label: 'vp9, three rungs', url: local('vp9-dash/manifest.mpd'), topic: 'local' },
        {
          label: 'Muxed MPEG-TS',
          url: local('ts/master.m3u8'),
          topic: 'local',
          tags: ['needs ts-transmux'],
        },
        {
          label: 'Packed AAC audio',
          url: local('aac/master.m3u8'),
          topic: 'local',
          tags: ['needs packed-audio'],
        },
        {
          label: 'Image playlists and Apple chapters',
          url: local('h264-images/master.m3u8'),
          topic: 'previews',
          tags: ['generated', 'tiles in manifest', 'chapters in manifest'],
        },
      ];

export const STREAMS: readonly StreamEntry[] = [
  ...LOCAL_STREAMS,
  {
    label: 'DASH-IF · Big Buck Bunny',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
    topic: 'vod',
    chapters: chapterFile('big-buck-bunny.vtt'),
  },
  {
    label: 'Apple · bipbop basic',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8',
    topic: 'vod',
    tags: ['TS', 'CEA-608'],
  },
  {
    // I-frame playlists are byte ranges into the normal fMP4 fragments; the
    // trick-play stage rebuilds each as one key frame lasting its slot.
    label: 'Apple · advanced example, fMP4',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    topic: 'trick',
    tags: ['I-frame playlists', 'alternate audio', 'subtitles'],
  },
  {
    // The same content in TS: each I-frame range starts past the program
    // tables, which the stage takes from the start of the file.
    label: 'Apple · advanced example, TS',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    topic: 'trick',
    tags: ['TS', 'I-frame playlists', 'alternate audio', 'subtitles'],
  },
  {
    // DASH-IF trick mode: an AdaptationSet with the trickmode
    // EssentialProperty, one frame per 2 s segment, maxPlayoutRate 60.
    label: 'DASH-IF livesim · trick mode, on demand',
    url: 'https://livesim2.dashif.org/vod/testpic_2s/Manifest_trickmode.mpd',
    topic: 'trick',
    tags: ['trick-mode AdaptationSet'],
  },
  {
    // Live: scanning forward stops at the live edge.
    label: 'DASH-IF livesim · trick mode, live',
    url: 'https://livesim2.dashif.org/livesim2/testpic_2s/Manifest_trickmode.mpd',
    topic: 'trick',
    tags: ['live', 'trick-mode AdaptationSet'],
  },
  {
    label: 'Apple · bipbop 16x9',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    topic: 'trick',
    tags: ['TS', 'I-frame playlists', 'CEA-608'],
  },
  {
    label: 'Unified Streaming · Tears of Steel',
    url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
    topic: 'vod',
    chapters: chapterFile('tears-of-steel.vtt'),
  },
  {
    label: 'SRG SSR · RTS (fr)',
    url: 'https://rts-vod-amd.akamaized.net/ww/14683290/5bb14625-55e0-328c-bb9d-d5be774abd88/master.m3u8',
    topic: 'vod',
  },
  {
    // DASH-IF thumbnail tiles: an image AdaptationSet with the thumbnail_tile
    // EssentialProperty. The thumbnails stage reads it with no track URL.
    label: 'DASH-IF · Big Buck Bunny, 10x1 tiles, chapters with images',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_with_tiled_thumbnails.mpd',
    topic: 'previews',
    tags: ['tiles in manifest'],
    chapters: chapterFile('big-buck-bunny-metadata.vtt'),
  },
  {
    // Fractional tile widths: a 2048 px sheet split into 10 columns.
    label: 'DASH-IF · Big Buck Bunny, 4 sheets of tiles',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_with_4_tiles_thumbnails.mpd',
    topic: 'previews',
    tags: ['tiles in manifest'],
    chapters: chapterFile('big-buck-bunny.vtt'),
  },
  {
    // One 10x20 sheet for the whole film: 200 tiles, fractional tile size.
    label: 'DASH-IF · Big Buck Bunny, one 10x20 sheet',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_with_tiled_thumbnails_2.mpd',
    topic: 'previews',
    tags: ['tiles in manifest'],
    chapters: chapterFile('big-buck-bunny.vtt'),
  },
  {
    // Two image representations in one set; the stage uses the first.
    label: 'DASH-IF · Big Buck Bunny, two thumbnail sizes',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_with_multiple_tiled_thumbnails.mpd',
    topic: 'previews',
    tags: ['tiles in manifest'],
    chapters: chapterFile('big-buck-bunny.vtt'),
  },
  {
    // Live: one 1x1 image per 2 s segment on an open template.
    label: 'DASH-IF livesim · live with thumbnails',
    url: 'https://livesim2.dashif.org/livesim2/testpic_2s/Manifest_thumbs.mpd',
    topic: 'previews',
    tags: ['live', 'tiles in manifest'],
  },
  {
    // Public sprite-sheet thumbnails (WebVTT with #xywh tiles), the format the
    // thumbnails stage reads. The CDN wants a Referer, which the browser sends.
    label: 'Bitmovin · Art of Motion',
    url: 'https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8',
    topic: 'previews',
    thumbnails:
      'https://bitdash-a.akamaihd.net/content/MI201109210084_1/thumbnails/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.vtt',
  },
  {
    label: 'Bitmovin · Art of Motion',
    url: 'https://bitdash-a.akamaihd.net/content/MI201109210084_1/mpds/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.mpd',
    topic: 'previews',
    thumbnails:
      'https://bitdash-a.akamaihd.net/content/MI201109210084_1/thumbnails/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.vtt',
  },
  {
    label: 'SRG SSR · RTS Info',
    url: 'https://rtsinfo-d.akamaized.net/out/v1/lsvs/rts-info/cmaf/hls-master.m3u8?dw=7201',
    topic: 'live',
    tags: ['live', 'DVR'],
  },
  {
    label: 'SRG SSR · Couleur 3, audio',
    url: 'https://stxt-audiostreaming.akamaized.net/hls/live/2117380/couleur3/master.m3u8',
    topic: 'live',
    tags: ['live', 'DVR', 'audio only'],
  },
  {
    // An Akamai live-push test stream (Big Buck Bunny on a loop), not RTS.
    label: 'Akamai live push · Big Buck Bunny, small window',
    url: 'https://hls-harbor-livepush.akamaized.net/live_cdn/nsqIStpj8PaG-Ev/emcQJ0pGpremocy/index.m3u8',
    topic: 'live',
    tags: ['live', 'TS'],
  },
  {
    label: 'DASH-IF livesim · test picture',
    url: 'https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd',
    topic: 'live',
    tags: ['live'],
  },
  {
    // A server-side ad-inserted VOD: ad breaks stitched in with
    // EXT-X-DISCONTINUITY, each break its own timeline and encoding.
    label: 'Mux · stitched ads, 4 discontinuities',
    url: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
    topic: 'ads',
  },
  {
    // Multi-period DASH is how ad insertion is signaled in DASH: one period
    // per content or ad segment, each with its own timeline.
    label: 'DASH-IF · multi-period, test case 5a',
    url: 'https://dash.akamaized.net/dash264/TestCases/5a/nomor/1.mpd',
    topic: 'ads',
    tags: ['plays the first period only'],
  },
  {
    label: 'Shaka · Angel One',
    url: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd',
    topic: 'drm',
    licenseUrl: 'https://cwip-shaka-proxy.appspot.com/no_auth',
    keySystem: 'Widevine',
  },
  {
    label: 'Shaka · Sintel, Widevine and PlayReady',
    url: 'https://storage.googleapis.com/shaka-demo-assets/sintel-widevine/dash.mpd',
    topic: 'drm',
    licenseUrl: 'https://cwip-shaka-proxy.appspot.com/no_auth',
  },
];
