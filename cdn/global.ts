/**
 * The shape every CDN bundle exposes on its one global, `mattebox`:
 *
 *   mattebox({ stages: [...] })   the engine factory, hand composition
 *   mattebox.preset({ ... })      the bundle's preset, defaults plus overrides
 *   mattebox.preset.stages()      the preset's stage list
 *   mattebox.hlsCmaf(), ...       the stage factories the bundle carries
 *   mattebox.from(video)          the element-to-engine lookup
 *
 * Rolldown builds each entry with `output.exports: 'default'`, which makes
 * the default export the global. This helper lives outside `src/` because
 * the entries read `document.currentScript` at load, a top-level side
 * effect the package modules must not have.
 */
import type { Mattebox, MatteboxOptions } from '../src/index.js';
import { mattebox } from '../src/index.js';
import type { Preset } from '../src/presets/define.js';

export function cdnGlobal<S extends Record<string, unknown>>(preset: Preset, stages: S) {
  return Object.assign((options: MatteboxOptions = {}): Mattebox => mattebox(options), {
    from: mattebox.from,
    preset,
    ...stages,
  });
}
