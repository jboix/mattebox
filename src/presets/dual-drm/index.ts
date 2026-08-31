/**
 * The `dual-drm` preset: `dual` plus the EME stages.
 */
import { definePreset } from '../define.js';
import { base, dashLine, drmTier, hlsLine } from '../tiers.js';

const preset = definePreset('dual-drm', () => [
  ...hlsLine(),
  ...dashLine(),
  ...base(),
  ...drmTier(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
