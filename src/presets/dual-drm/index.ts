/**
 * The `dual-drm` preset: `dual` plus the EME stages.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { dashLine } from '../tiers/dash.js';
import { drmTier } from '../tiers/drm.js';
import { hlsLine } from '../tiers/hls.js';

const preset = definePreset('dual-drm', () => [
  ...hlsLine(),
  ...dashLine(),
  ...base(),
  ...drmTier(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
