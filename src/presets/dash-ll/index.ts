/**
 * The `dash-ll` preset: low-latency DASH on demand and live, CMAF segments,
 * live catch-up, the base. An MPD without low-latency signalling plays as
 * in `dash`.
 */
import { definePreset } from '../define.js';
import { base, dashLlLine, lowLatencyTier } from '../tiers.js';

const preset = definePreset('dash-ll', () => [...dashLlLine(), ...lowLatencyTier(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
