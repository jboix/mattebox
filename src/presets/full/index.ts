/**
 * The `full` preset: every stage the catalogue ships. `dual-ts-drm` plus
 * the accessories: CMCD (changes every request, so opt-in elsewhere) and
 * thumbnails (needs an app-supplied sprite track). Feature parity with
 * videojs-http-streaming; the modularity claim is measured against it, and
 * the main CDN bundle exposes it.
 */
import cmcd from '../../stages/cmcd/index.js';
import thumbnails from '../../stages/thumbnails/index.js';
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
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
