/**
 * The shape every CDN bundle exposes on its `mattebox` global: the engine
 * factory, `preset`, `preset.stages()`, the stage factories it carries,
 * `from(video)`, and the track label functions a player's menus call.
 */
import type { Mattebox, MatteboxOptions } from '../src/index.js';
import { isAudioDescription, isEnhancedSpeech, isOriginal, isSdh, mattebox } from '../src/index.js';
import type { Preset } from '../src/presets/define.js';

export function cdnGlobal<S extends Record<string, unknown>>(preset: Preset, stages: S) {
  return Object.assign((options: MatteboxOptions = {}): Mattebox => mattebox(options), {
    from: mattebox.from,
    preset,
    isAudioDescription,
    isEnhancedSpeech,
    isOriginal,
    isSdh,
    ...stages,
  });
}
