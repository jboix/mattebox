/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */
import dashLl from '../../protocols/dash-ll/index.js';
import type { Stage } from '../../types/stage.js';

/**
 * Low-latency DASH: dash-ll in place of dash-cmaf and dash-live, which it
 * contains. An MPD without low-latency signalling plays as the DASH line
 * plays it.
 */
export function dashLlLine(): Stage[] {
  return [dashLl()];
}
