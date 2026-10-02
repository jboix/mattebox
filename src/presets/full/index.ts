/**
 * The `full` preset: every stage the catalogue ships. `dual-ts-drm` plus
 * the accessories: CMCD (changes every request, so opt-in elsewhere),
 * thumbnails (fetches image playlists, so opt-in elsewhere), chapters
 * (loads a file the app names), trick play (a UI control drives it), and
 * timed metadata (a page reads it).
 * Feature parity with
 * videojs-http-streaming; the modularity claim is measured against it, and
 * the main CDN bundle exposes it.
 */
import chapters from '../../stages/chapters/index.js';
import cmcd from '../../stages/cmcd/index.js';
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
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
