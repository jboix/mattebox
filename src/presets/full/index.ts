/**
 * The `full` preset: every stage the catalogue ships. `dual-ts-drm` plus
 * the accessories: CMCD (changes every request, so opt-in elsewhere),
 * thumbnails (fetches image playlists, so opt-in elsewhere), chapters
 * (loads a file the app names), trick play (a UI control drives it),
 * timed metadata (a page reads it), CEA-708 captions (US broadcast
 * streams carry 608 beside them, which the base reads), TTML subtitles
 * (opt-in by the owner's decision), HDR by capability (it excludes HDR
 * where nothing is known, which a page may not want by default), local
 * QoE metrics, and CMSD (it acts on response headers a CDN must expose).
 * Feature parity with
 * videojs-http-streaming; the modularity claim is measured against it, and
 * the main CDN bundle exposes it.
 */
import chapters from '../../stages/chapters/index.js';
import cmcd from '../../stages/cmcd/index.js';
import cmsd from '../../stages/cmsd/index.js';
import hdr from '../../stages/hdr/index.js';
import qoe from '../../stages/qoe/index.js';
import textCea708 from '../../stages/text-cea708/index.js';
import textTtml from '../../stages/text-ttml/index.js';
import thumbnails from '../../stages/thumbnails/index.js';
import timedMetadata from '../../stages/timed-metadata/index.js';
import trickPlay from '../../stages/trick-play/index.js';
import { definePreset } from '../define.js';
import { base, dashLine, drmTier, hlsLine, tsTier } from '../tiers.js';

const preset = definePreset('full', () => [
  ...hlsLine(),
  ...dashLine(),
  ...base(),
  ...tsTier(),
  ...drmTier(),
  cmcd(),
  thumbnails(),
  chapters(),
  trickPlay(),
  timedMetadata(),
  textCea708(),
  textTtml(),
  hdr(),
  qoe(),
  cmsd(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
