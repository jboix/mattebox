/**
 * The `dash-ll` preset: low-latency DASH on demand and live, CMAF segments,
 * live catch-up, the base. An MPD without low-latency signalling plays as
 * in `dash`.
 */
import { definePreset } from '../define.js';
import { base } from '../tiers/base.js';
import { dashLlLine } from '../tiers/dash-ll.js';
import { lowLatencyTier } from '../tiers/low-latency.js';

const preset = definePreset('dash-ll', () => [...dashLlLine(), ...lowLatencyTier(), ...base()]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
