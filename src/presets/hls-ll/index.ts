/**
 * The `hls-ll` preset: low-latency HLS on demand and live, CMAF segments,
 * live catch-up, the base. A stream without parts plays as in `hls`.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { hlsLlLine } from '../tiers/hls-ll.js';
import { lowLatencyTier } from '../tiers/low-latency.js';

const preset = definePreset('hls-ll', () => [...hlsLlLine(), ...lowLatencyTier(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
