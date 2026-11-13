/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */
import liveCatchup from '../../stages/live-catchup/index.js';
import type { Stage } from '../../types/stage.js';

/**
 * What a low-latency line needs beside it: the catch-up that holds the
 * latency. It holds any live stream at its hold-back.
 */
export function lowLatencyTier(): Stage[] {
  return [liveCatchup()];
}
