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

export interface StreamEntry {
  readonly label: string;
  readonly url: string;
  /** License server for encrypted demo streams; prefilled when the entry is chosen. */
  readonly licenseUrl?: string;
  /** Vendor name from the key-system selector, when one should be preferred. */
  readonly keySystem?: string;
  /** A WebVTT sprite-sheet thumbnail track, for the thumbnails stage. */
  readonly thumbnails?: string;
}

/**
 * The corpus generated by `test/e2e/gen-streams.sh`. The dev server serves it
 * from its public dir, and the GitHub Pages workflow copies it next to the
 * built site, so the URLs hang off Vite's base path. `VITE_LOCAL_STREAMS=off`
 * drops the entries, for a build that ships without the corpus (the pull
 * request previews).
 */
const local = (path: string): string => `${import.meta.env.BASE_URL}streams/${path}`;

const LOCAL_STREAMS: readonly StreamEntry[] =
  import.meta.env.VITE_LOCAL_STREAMS === 'off'
    ? []
    : [
        { label: 'local h264 (generated)', url: local('h264/master.m3u8') },
        { label: 'local vp9 (generated)', url: local('vp9/master.m3u8') },
        { label: 'local h264 DASH (generated)', url: local('h264-dash/manifest.mpd') },
        { label: 'local vp9 DASH (generated)', url: local('vp9-dash/manifest.mpd') },
        { label: 'local muxed TS (generated, needs ts-transmux)', url: local('ts/master.m3u8') },
        {
          label: 'local packed AAC (generated, needs packed-audio)',
          url: local('aac/master.m3u8'),
        },
      ];

export const STREAMS: readonly StreamEntry[] = [
  ...LOCAL_STREAMS,
  {
    label: 'DASH-IF · Big Buck Bunny',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
  },
  {
    // Public sprite-sheet thumbnails (WebVTT with #xywh tiles), the format the
    // thumbnails stage reads. The CDN wants a Referer, which the browser sends.
    label: 'Bitmovin · Art of Motion (HLS, WebVTT thumbnails)',
    url: 'https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8',
    thumbnails:
      'https://bitdash-a.akamaihd.net/content/MI201109210084_1/thumbnails/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.vtt',
  },
  {
    label: 'Bitmovin · Art of Motion (DASH, WebVTT thumbnails)',
    url: 'https://bitdash-a.akamaihd.net/content/MI201109210084_1/mpds/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.mpd',
    thumbnails:
      'https://bitdash-a.akamaihd.net/content/MI201109210084_1/thumbnails/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.vtt',
  },
  {
    // DASH-IF thumbnail tiles: an image AdaptationSet with the thumbnail_tile
    // EssentialProperty. Not discovered by the engine yet (see docs/17).
    label: 'DASH-IF · Big Buck Bunny (tiled thumbnails in the MPD, not wired yet)',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_with_tiled_thumbnails.mpd',
  },
  {
    label: 'SRG SSR · RTS (fr)',
    url: 'https://rts-vod-amd.akamaized.net/ww/14683290/5bb14625-55e0-328c-bb9d-d5be774abd88/master.m3u8',
  },
  {
    // A server-side ad-inserted VOD: ad breaks stitched in with
    // EXT-X-DISCONTINUITY, each break its own timeline and encoding.
    label: 'Mux · DAI stitched ads (HLS, 4 discontinuities)',
    url: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
  },
  {
    // Multi-period DASH is how ad insertion is signaled in DASH: one period
    // per content or ad segment, each with its own timeline.
    label: 'DASH-IF · multi-period (ad-insertion layout, test case 5a)',
    url: 'https://dash.akamaized.net/dash264/TestCases/5a/nomor/1.mpd',
  },
  {
    label: 'Apple bipbop basic',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8',
  },
  {
    label: 'Unified Streaming · Tears of Steel',
    url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
  },
  {
    label: 'Shaka · Angel One (Widevine DASH)',
    url: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd',
    licenseUrl: 'https://cwip-shaka-proxy.appspot.com/no_auth',
    keySystem: 'Widevine',
  },
  {
    label: 'Shaka · Sintel (Widevine + PlayReady DASH)',
    url: 'https://storage.googleapis.com/shaka-demo-assets/sintel-widevine/dash.mpd',
    licenseUrl: 'https://cwip-shaka-proxy.appspot.com/no_auth',
  },
  {
    label: 'RTS · live (muxed TS, small window)',
    url: 'https://hls-harbor-livepush.akamaized.net/live_cdn/nsqIStpj8PaG-Ev/emcQJ0pGpremocy/index.m3u8',
  },
  {
    label: 'SRG SSR · Couleur 3 (live audio DVR)',
    url: 'https://stxt-audiostreaming.akamaized.net/hls/live/2117380/couleur3/master.m3u8',
  },
  {
    label: 'SRG SSR · RTS Info (live CMAF video DVR)',
    url: 'https://rtsinfo-d.akamaized.net/out/v1/lsvs/rts-info/cmaf/hls-master.m3u8?dw=7201',
  },
];
