/**
 * The `dual-ts` preset: `dual` plus the MPEG-TS family.
 */
import { definePreset } from '../define.js';
import { base, dashLine, hlsLine, tsTier } from '../tiers.js';

const preset = definePreset('dual-ts', () => [...hlsLine(), ...dashLine(), ...base(), ...tsTier()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
