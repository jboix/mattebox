/**
 * The preset contract. A preset is a factory that returns an engine already
 * composed with a known stack, so a consumer with an ordinary need writes one
 * call. Overrides merge by stage name: a stage handed in under a name the
 * preset already composes replaces the preset's instance (the way to pass
 * options to one of them), any other name appends after the preset's own
 * stages, and `without` drops preset stages by name. The loader still
 * validates the result, so removing a stage another one requires fails at
 * construction with both names in the message.
 */
import type { Mattebox } from '../index.js';
import { mattebox } from '../index.js';
import type { MatteboxOptions } from '../types/facade.js';
import type { Stage } from '../types/stage.js';

export interface PresetOptions extends MatteboxOptions {
  /** Stages merged into the preset's: a matching name replaces, any other appends. */
  readonly stages?: readonly Stage[];
  /** Names of preset stages to leave out. */
  readonly without?: readonly string[];
}

export type PresetStageOptions = Pick<PresetOptions, 'stages' | 'without'>;

export interface Preset {
  /** Composes an engine from the preset's stages plus the overrides. */
  (options?: PresetOptions): Mattebox;
  readonly presetName: string;
  /** The stages the preset composes after the overrides apply, as fresh instances. */
  stages(options?: PresetStageOptions): Stage[];
}

/** Applies the merge rule. Exported for tests; presets call it through `stages`. */
export function mergeStages(defaults: readonly Stage[], options: PresetStageOptions = {}): Stage[] {
  const without = new Set(options.without ?? []);
  const overrides = new Map<string, Stage>();
  for (const stage of options.stages ?? []) overrides.set(stage.name, stage);
  const out: Stage[] = [];
  for (const stage of defaults) {
    if (without.has(stage.name)) continue;
    const override = overrides.get(stage.name);
    if (override === undefined) {
      out.push(stage);
      continue;
    }
    out.push(override);
    overrides.delete(stage.name);
  }
  for (const stage of overrides.values()) out.push(stage);
  return out;
}

/**
 * Builds a preset from a name and a function returning fresh default stage
 * instances. A function, not an array: a stage instance carries install
 * state, so every engine must get its own.
 */
export function definePreset(presetName: string, defaults: () => readonly Stage[]): Preset {
  function stages(options?: PresetStageOptions): Stage[] {
    return mergeStages(defaults(), options);
  }
  const preset = (options: PresetOptions = {}): Mattebox => {
    const { stages: _overrides, without: _without, ...rest } = options;
    return mattebox({ ...rest, stages: stages(options) });
  };
  return Object.assign(preset, { presetName, stages });
}
