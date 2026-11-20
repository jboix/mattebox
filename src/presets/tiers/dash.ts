/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */

import webm from '../../containers/webm/index.js';
import dashCmaf from '../../protocols/dash-cmaf/index.js';
import dashLive from '../../protocols/dash-live/index.js';
import type { Stage } from '../../types/stage.js';

/** DASH on demand and live, with WebM next to MP4, as dash.js and Shaka Player play it. */
export function dashLine(): Stage[] {
  return [dashCmaf(), dashLive(), webm()];
}
