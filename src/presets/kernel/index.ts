/**
 * The `kernel` preset: the engine with zero stages. It attaches and manages
 * buffers but parses nothing; it is the floor the size budget measures and
 * the base to build a fully custom stack on with `stages`.
 */
import { definePreset } from '../define.js';

const preset = definePreset('kernel', () => []);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
