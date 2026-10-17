/**
 * The `dual-ll` preset: low-latency HLS and DASH, CMAF segments, live
 * catch-up, the base. One engine for a catalogue that mixes HLS and DASH
 * live channels.
 */
import { definePreset } from '../define.js';
import { base, dashLine, hlsLlLine } from '../tiers.js';

const preset = definePreset('dual-ll', () => [...hlsLlLine(), ...dashLine(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
