/**
 * The `hls-ts` preset: `hls` plus the MPEG-TS family, for a backend that still emits transport streams.
 */
import { definePreset } from '../define.js';
import { base, hlsLine, tsTier } from '../tiers.js';

const preset = definePreset('hls-ts', () => [...hlsLine(), ...base(), ...tsTier()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
