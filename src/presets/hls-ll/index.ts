/**
 * The `hls-ll` preset: low-latency HLS on demand and live, CMAF segments,
 * live catch-up, the base. A stream without parts plays as in `hls`.
 */
import { definePreset } from '../define.js';
import { base, hlsLlLine, lowLatencyTier } from '../tiers.js';

const preset = definePreset('hls-ll', () => [...hlsLlLine(), ...lowLatencyTier(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
