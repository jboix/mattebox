/**
 * The `dual-ll` preset: low-latency HLS and low-latency DASH, CMAF
 * segments, live catch-up, the base. One engine for a catalogue that mixes
 * HLS and DASH live channels.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { dashLlLine } from '../tiers/dash-ll.js';
import { hlsLlLine } from '../tiers/hls-ll.js';
import { lowLatencyTier } from '../tiers/low-latency.js';

const preset = definePreset('dual-ll', () => [
  ...hlsLlLine(),
  ...dashLlLine(),
  ...lowLatencyTier(),
  ...base(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
