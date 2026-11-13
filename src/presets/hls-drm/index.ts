/**
 * The `hls-drm` preset: `hls` plus the EME stages, for protected HLS.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { drmTier } from '../tiers/drm.js';
import { hlsLine } from '../tiers/hls.js';

const preset = definePreset('hls-drm', () => [...hlsLine(), ...base(), ...drmTier()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
