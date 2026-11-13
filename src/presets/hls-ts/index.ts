/**
 * The `hls-ts` preset: `hls` plus the MPEG-TS family, for a backend that still emits transport streams.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { hlsLine } from '../tiers/hls.js';
import { tsTier } from '../tiers/ts.js';

const preset = definePreset('hls-ts', () => [...hlsLine(), ...base(), ...tsTier()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
