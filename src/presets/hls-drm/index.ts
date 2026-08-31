/**
 * The `hls-drm` preset: `hls` plus the EME stages, for protected HLS.
 */
import { definePreset } from '../define.js';
import { base, drmTier, hlsLine } from '../tiers.js';

const preset = definePreset('hls-drm', () => [...hlsLine(), ...base(), ...drmTier()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
