/**
 * The building blocks of the preset matrix. Three axes answer a technical
 * requirement, each set by the packaging backend or the rights situation:
 * the protocol line (HLS, DASH, both), the container tier (CMAF only, or
 * legacy MPEG-TS as well, an HLS-side axis), and the DRM tier. Every preset
 * carries the same base on top of its line. Each group is a function so a
 * preset gets fresh stage instances, and a group a preset never calls
 * tree-shakes out of it with the stages it imports.
 */
import packedAudio from '../containers/packed-audio/index.js';
import tsTransmux from '../containers/ts-transmux/index.js';
import dashCmaf from '../protocols/dash-cmaf/index.js';
import dashLive from '../protocols/dash-live/index.js';
import hlsCmaf from '../protocols/hls-cmaf/index.js';
import hlsLive from '../protocols/hls-live/index.js';
import abr from '../stages/abr/index.js';
import abrCapSize from '../stages/abr-cap-size/index.js';
import abrPersist from '../stages/abr-persist/index.js';
import aes128 from '../stages/aes-128/index.js';
import altAudio from '../stages/alt-audio/index.js';
import cmafTiming from '../stages/cmaf-timing/index.js';
import codecSwitch from '../stages/codec-switch/index.js';
import contentSteering from '../stages/content-steering/index.js';
import emeCenc from '../stages/eme-cenc/index.js';
import emeCore from '../stages/eme-core/index.js';
import emeFairplay from '../stages/eme-fairplay/index.js';
import metaId3 from '../stages/meta-id3/index.js';
import nalScan from '../stages/nal-scan/index.js';
import pdt from '../stages/pdt/index.js';
import recovery from '../stages/recovery/index.js';
import textCea608 from '../stages/text-cea608/index.js';
import textWebvtt from '../stages/text-webvtt/index.js';
import textWebvttSegmented from '../stages/text-webvtt-segmented/index.js';
import type { Stage } from '../types/stage.js';
import { localThroughputStorage } from './storage.js';

/** HLS on demand and live, with program date time. */
export function hlsLine(): Stage[] {
  // AES-128 rides with HLS: full-segment keys are common enough on HLS, and
  // the stage is a kilobyte, so no HLS deployment should meet one unprepared.
  return [hlsCmaf(), hlsLive(), pdt(), aes128()];
}

/** DASH on demand and live. */
export function dashLine(): Stage[] {
  return [dashCmaf(), dashLive()];
}

/**
 * What every preset carries: adaptive quality with a size cap and bandwidth
 * memory, recovery, content steering (inert until a manifest asks for it),
 * alternate audio with codec switching, WebVTT subtitles, and CMAF live
 * timing, which corrects the broadcast-clock tfdt some live packagers write
 * and leaves VOD untouched.
 */
export function base(): Stage[] {
  return [
    abr(),
    abrCapSize(),
    abrPersist(localThroughputStorage()),
    recovery(),
    contentSteering(),
    codecSwitch(),
    altAudio(),
    textWebvtt(),
    textWebvttSegmented(),
    cmafTiming(),
  ];
}

/**
 * Legacy MPEG-TS: the transmuxer and packed audio, plus what rides on the
 * transport stream, CEA-608 captions and ID3 metadata. nal-scan is included
 * so a mixed backend gets the same captions from its CMAF renditions.
 */
export function tsTier(): Stage[] {
  return [tsTransmux(), packedAudio(), nalScan(), textCea608(), metaId3()];
}

/** The EME stages: sessions, CENC (Widevine, PlayReady, ClearKey), FairPlay. */
export function drmTier(): Stage[] {
  return [emeCore(), emeCenc(), emeFairplay()];
}
