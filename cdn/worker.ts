/**
 * ts-transmux for a script-tag bundle: the Worker's source is embedded by
 * rolldown.config.mjs and started from a blob URL. A caller's own
 * `workerUrl` still wins.
 */

import workerSource from 'virtual:transmux-worker';
import tsTransmuxStage from '../src/containers/ts-transmux/index.js';
import type { TransmuxRunnerOptions } from '../src/containers/ts-transmux/runner.js';
import type { Preset, PresetOptions, PresetStageOptions } from '../src/presets/define.js';

let workerUrl: string | null = null;

/** The embedded Worker's blob URL, created on first use. */
function embeddedWorkerUrl(): string {
  workerUrl ??= URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  return workerUrl;
}

export function tsTransmux(options: TransmuxRunnerOptions = {}) {
  return options.workerUrl !== undefined
    ? tsTransmuxStage(options)
    : tsTransmuxStage({ ...options, workerUrl: embeddedWorkerUrl() });
}

function located(options: PresetStageOptions = {}): PresetStageOptions {
  return { ...options, stages: [tsTransmux(), ...(options.stages ?? [])] };
}

/** The preset with ts-transmux pointed at the embedded Worker. */
export function withWorker(preset: Preset): Preset {
  return Object.assign((options: PresetOptions = {}) => preset(located(options)), {
    presetName: preset.presetName,
    stages: (options?: PresetStageOptions) => preset.stages(located(options)),
  });
}
