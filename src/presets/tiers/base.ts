/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */
import abr from '../../stages/abr/index.js';
import abrCapSize from '../../stages/abr-cap-size/index.js';
import altAudio from '../../stages/alt-audio/index.js';
import cmafTiming from '../../stages/cmaf-timing/index.js';
import codecProbe from '../../stages/codec-probe/index.js';
import codecSwitch from '../../stages/codec-switch/index.js';
import contentSteering from '../../stages/content-steering/index.js';
import forcedSubtitles from '../../stages/forced-subtitles/index.js';
import mp4Box from '../../stages/mp4-box/index.js';
import nalScan from '../../stages/nal-scan/index.js';
import pdt from '../../stages/pdt/index.js';
import recovery from '../../stages/recovery/index.js';
import textCea608 from '../../stages/text-cea608/index.js';
import textWebvtt from '../../stages/text-webvtt/index.js';
import textWebvttSegmented from '../../stages/text-webvtt-segmented/index.js';
import type { Stage } from '../../types/stage.js';

/**
 * What every preset carries: adaptive quality with a size cap, recovery, content steering (inert until a manifest asks for it),
 * alternate audio with codec switching, WebVTT subtitles, CMAF timing (reads
 * each segment's decode time so the kernel lands it at its playlist time,
 * whatever clock the packager wrote), program date time from either
 * protocol's anchor, the codec probe (types a SourceBuffer whose playlist
 * declares no codecs, which Chrome otherwise refuses), and CEA-608 captions
 * from fMP4 video. The caption scan costs per NAL unit, not per byte, and
 * only when a segment has H.264 or HEVC.
 */
export function base(): Stage[] {
  return [
    abr(),
    abrCapSize(),
    recovery(),
    contentSteering(),
    codecSwitch(),
    altAudio(),
    textWebvtt(),
    textWebvttSegmented(),
    forcedSubtitles(),
    cmafTiming(),
    pdt(),
    mp4Box(),
    codecProbe(),
    nalScan(),
    textCea608(),
  ];
}
