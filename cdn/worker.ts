/**
 * The ts-transmux factory for a script-tag bundle. An IIFE has no
 * `import.meta.url`, so the Worker cannot be found the way a bundler
 * resolves it. This records the script's own URL while it executes and
 * points `tsTransmux` at the sibling `transmux.worker.js` the CDN build
 * emits next to every bundle that carries the transmuxer. A page that loads
 * both from the same directory gets the Worker path with no configuration;
 * one that hosts the Worker elsewhere passes `workerUrl` as usual.
 *
 * `located` prepends a located instance to a preset's overrides, so the
 * merge replaces the preset's default and a caller's own `tsTransmux(...)`
 * still wins by coming later.
 */

import tsTransmuxStage from '../src/containers/ts-transmux/index.js';
import type { TransmuxRunnerOptions } from '../src/containers/ts-transmux/runner.js';
import type { Preset, PresetOptions, PresetStageOptions } from '../src/presets/define.js';

const scriptUrl =
  typeof document === 'undefined'
    ? null
    : (document.currentScript as HTMLScriptElement | null)?.src;
const workerUrl = scriptUrl ? new URL('./transmux.worker.js', scriptUrl).href : null;

export function tsTransmux(options: TransmuxRunnerOptions = {}) {
  return workerUrl === null || options.workerUrl !== undefined
    ? tsTransmuxStage(options)
    : tsTransmuxStage({ ...options, workerUrl });
}

function located(options: PresetStageOptions = {}): PresetStageOptions {
  return { ...options, stages: [tsTransmux(), ...(options.stages ?? [])] };
}

/** The preset with its ts-transmux default pointed at the sibling Worker. */
export function withWorker(preset: Preset): Preset {
  return Object.assign((options: PresetOptions = {}) => preset(located(options)), {
    presetName: preset.presetName,
    stages: (options?: PresetStageOptions) => preset.stages(located(options)),
  });
}
