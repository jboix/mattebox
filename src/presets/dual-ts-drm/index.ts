/**
 * The `dual-ts-drm` preset: both lines, MPEG-TS, and DRM. Everything a production backend needs; `full` adds only the accessories.
 */
import { definePreset } from '../define.js';
import { base, dashLine, drmTier, hlsLine, tsTier } from '../tiers.js';

const preset = definePreset('dual-ts-drm', () => [
  ...hlsLine(),
  ...dashLine(),
  ...base(),
  ...tsTier(),
  ...drmTier(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
