/**
 * The `hls-ts-drm` preset: `hls-ts` plus the EME stages.
 */
import { definePreset } from '../define.js';
import { base, drmTier, hlsLine, tsTier } from '../tiers.js';

const preset = definePreset('hls-ts-drm', () => [
  ...hlsLine(),
  ...base(),
  ...tsTier(),
  ...drmTier(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
