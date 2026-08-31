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

export interface CatalogueEntry {
  readonly name: string;
  readonly layer: 'protocols' | 'containers' | 'stages';
  readonly requires: readonly string[];
  readonly factory: (() => Stage) | null;
}

export const CATALOGUE: readonly CatalogueEntry[] = [
  { name: 'hls-cmaf', layer: 'protocols', requires: [], factory: hlsCmaf },
  { name: 'hls-live', layer: 'protocols', requires: ['hls-cmaf'], factory: hlsLive },
  { name: 'dash-cmaf', layer: 'protocols', requires: [], factory: dashCmaf },
  { name: 'dash-live', layer: 'protocols', requires: ['dash-cmaf'], factory: dashLive },
  { name: 'pdt', layer: 'stages', requires: [], factory: pdt },
  { name: 'mp4-box', layer: 'containers', requires: [], factory: mp4Box },
  { name: 'codec-probe', layer: 'containers', requires: ['mp4-box'], factory: codecProbe },
  { name: 'codec-switch', layer: 'containers', requires: ['mse'], factory: codecSwitch },
  { name: 'ts-transmux', layer: 'containers', requires: [], factory: tsTransmux },
  { name: 'aes-128', layer: 'containers', requires: ['transport'], factory: aes128 },
  { name: 'cmaf-timing', layer: 'containers', requires: [], factory: cmafTiming },
  { name: 'packed-audio', layer: 'containers', requires: [], factory: packedAudio },
  { name: 'meta-id3', layer: 'stages', requires: ['ts-transmux'], factory: metaId3 },
  {
    name: 'alt-audio',
    layer: 'stages',
    requires: ['scheduler', 'codec-switch'],
    factory: altAudio,
  },
  { name: 'abr', layer: 'stages', requires: ['scheduler', 'track-registry'], factory: abr },
  { name: 'abr-cap-size', layer: 'stages', requires: ['rendition-select'], factory: abrCapSize },
  {
    name: 'abr-persist',
    layer: 'stages',
    requires: ['abr'],
    factory: () => abrPersist(localThroughputStorage()),
  },
  { name: 'text-webvtt', layer: 'stages', requires: ['scheduler'], factory: textWebvtt },
  {
    name: 'text-webvtt-segmented',
    layer: 'stages',
    requires: ['text-webvtt'],
    factory: textWebvttSegmented,
  },
  { name: 'nal-scan', layer: 'stages', requires: [], factory: nalScan },
  { name: 'text-cea608', layer: 'stages', requires: ['ts-transmux'], factory: textCea608 },
  { name: 'eme-core', layer: 'stages', requires: ['mse'], factory: () => emeCore() },
  { name: 'eme-cenc', layer: 'stages', requires: ['eme-core'], factory: emeCenc },
  { name: 'eme-fairplay', layer: 'stages', requires: ['eme-core'], factory: () => emeFairplay() },
  { name: 'recovery', layer: 'stages', requires: ['scheduler', 'mse'], factory: recovery },
  { name: 'content-steering', layer: 'stages', requires: ['transport'], factory: contentSteering },
  { name: 'cmcd', layer: 'stages', requires: ['transport'], factory: cmcd },
  { name: 'thumbnails', layer: 'stages', requires: ['transport'], factory: thumbnails },
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
