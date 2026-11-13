/**
 * The `dual-ts` preset: `dual` plus the MPEG-TS family.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { dashLine } from '../tiers/dash.js';
import { hlsLine } from '../tiers/hls.js';
import { tsTier } from '../tiers/ts.js';

const preset = definePreset('dual-ts', () => [...hlsLine(), ...dashLine(), ...base(), ...tsTier()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
