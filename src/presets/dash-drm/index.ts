/**
 * The `dash-drm` preset: `dash` plus the EME stages, for protected DASH.
 */
import { definePreset } from '../define.js';
import { base, dashLine, drmTier } from '../tiers.js';

const preset = definePreset('dash-drm', () => [...dashLine(), ...base(), ...drmTier()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
