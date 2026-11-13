/**
 * The `dual-ts-drm` preset: both lines, MPEG-TS, and DRM. Everything a production backend needs; `full` adds only the accessories.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { dashLine } from '../tiers/dash.js';
import { drmTier } from '../tiers/drm.js';
import { hlsLine } from '../tiers/hls.js';
import { tsTier } from '../tiers/ts.js';

const preset = definePreset('dual-ts-drm', () => [
  ...hlsLine(),
  ...dashLine(),
  ...base(),
  ...tsTier(),
  ...drmTier(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
