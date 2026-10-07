/**
 * The stage factories a CDN global carries, grouped the way the presets
 * are. An entry spreads the groups its preset composes; the rest
 * tree-shakes out of that bundle.
 */

import packedAudio from '../src/containers/packed-audio/index.js';
import tsTransmux from '../src/containers/ts-transmux/index.js';
import { attachEme } from '../src/eme/index.js';
import dashCmaf from '../src/protocols/dash-cmaf/index.js';
import dashLive from '../src/protocols/dash-live/index.js';
import hlsCmaf from '../src/protocols/hls-cmaf/index.js';
import hlsLive from '../src/protocols/hls-live/index.js';
import abr from '../src/stages/abr/index.js';
import abrCapSize from '../src/stages/abr-cap-size/index.js';
import aes128 from '../src/stages/aes-128/index.js';
import altAudio from '../src/stages/alt-audio/index.js';
import chapters from '../src/stages/chapters/index.js';
import cmafTiming from '../src/stages/cmaf-timing/index.js';
import cmcd from '../src/stages/cmcd/index.js';
import cmsd from '../src/stages/cmsd/index.js';
import codecProbe from '../src/stages/codec-probe/index.js';
import codecSwitch from '../src/stages/codec-switch/index.js';
import contentSteering from '../src/stages/content-steering/index.js';
import emeCenc from '../src/stages/eme-cenc/index.js';
import emeCore from '../src/stages/eme-core/index.js';
import emeFairplay from '../src/stages/eme-fairplay/index.js';
import forcedSubtitles from '../src/stages/forced-subtitles/index.js';
import hdr from '../src/stages/hdr/index.js';
import metaId3 from '../src/stages/meta-id3/index.js';
import mp4Box from '../src/stages/mp4-box/index.js';
import nalScan from '../src/stages/nal-scan/index.js';
import pdt from '../src/stages/pdt/index.js';
import qoe from '../src/stages/qoe/index.js';
import recovery from '../src/stages/recovery/index.js';
import renditionNames from '../src/stages/rendition-names/index.js';
import textCea608 from '../src/stages/text-cea608/index.js';
import textCea708 from '../src/stages/text-cea708/index.js';
import textTtml from '../src/stages/text-ttml/index.js';
import textWebvtt from '../src/stages/text-webvtt/index.js';
import textWebvttSegmented from '../src/stages/text-webvtt-segmented/index.js';
import thumbnails from '../src/stages/thumbnails/index.js';
import timedMetadata from '../src/stages/timed-metadata/index.js';
import trickPlay from '../src/stages/trick-play/index.js';

export const hlsFactories = { hlsCmaf, hlsLive, aes128 };
export const dashFactories = { dashCmaf, dashLive };
export const baseFactories = {
  abr,
  abrCapSize,
  recovery,
  contentSteering,
  codecSwitch,
  altAudio,
  textWebvtt,
  textWebvttSegmented,
  forcedSubtitles,
  cmafTiming,
  pdt,
  mp4Box,
  codecProbe,
  nalScan,
  textCea608,
};
/** The TS tier. ts-transmux runs its one compiled copy, from cdn/transmux-source.ts. */
export const tsFactories = { tsTransmux, packedAudio, metaId3 };
// attachEme: the same DRM on an element the engine does not drive, such as
// Safari playing HLS natively. A player's own CDN bundle reads it here.
export const drmFactories = { emeCore, emeCenc, emeFairplay, attachEme };
export const accessoryFactories = {
  cmcd,
  thumbnails,
  chapters,
  trickPlay,
  timedMetadata,
  textCea708,
  textTtml,
  hdr,
  qoe,
  cmsd,
  renditionNames,
};
