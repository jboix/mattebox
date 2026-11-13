/**
 * The `hls-ts-drm` preset: `hls-ts` plus the EME stages.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { drmTier } from '../tiers/drm.js';
import { hlsLine } from '../tiers/hls.js';
import { tsTier } from '../tiers/ts.js';

const preset = definePreset('hls-ts-drm', () => [
  ...hlsLine(),
  ...base(),
  ...tsTier(),
  ...drmTier(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
