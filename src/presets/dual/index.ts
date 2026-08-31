/**
 * The `dual` preset: both protocol lines, CMAF segments, the base. One
 * engine for a catalogue that mixes HLS and DASH.
 */
import { definePreset } from '../define.js';
import { base, dashLine, hlsLine } from '../tiers.js';

const preset = definePreset('dual', () => [...hlsLine(), ...dashLine(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
