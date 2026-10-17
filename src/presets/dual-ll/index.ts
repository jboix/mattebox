/**
 * The `dual-ll` preset: low-latency HLS and low-latency DASH, CMAF
 * segments, live catch-up, the base. One engine for a catalogue that mixes
 * HLS and DASH live channels.
 */
import { definePreset } from '../define.js';
import { base, dashLlLine, hlsLlLine, lowLatencyTier } from '../tiers.js';

const preset = definePreset('dual-ll', () => [
  ...hlsLlLine(),
  ...dashLlLine(),
  ...lowLatencyTier(),
  ...base(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
