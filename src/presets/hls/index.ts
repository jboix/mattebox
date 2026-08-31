/**
 * The `hls` preset: HLS on demand and live, CMAF segments, the base.
 */
import { definePreset } from '../define.js';
import { base, hlsLine } from '../tiers.js';

const preset = definePreset('hls', () => [...hlsLine(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
