/**
 * The `dash` preset: DASH on demand and live, the base.
 */
import { definePreset } from '../define.js';
import { base, dashLine } from '../tiers.js';

const preset = definePreset('dash', () => [...dashLine(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
