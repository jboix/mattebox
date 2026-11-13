/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */
import hlsCmaf from '../../protocols/hls-cmaf/index.js';
import hlsLive from '../../protocols/hls-live/index.js';
import aes128 from '../../stages/aes-128/index.js';
import type { Stage } from '../../types/stage.js';

/** HLS on demand and live, with AES-128 segment decryption. */
export function hlsLine(): Stage[] {
  // AES-128 rides with HLS: full-segment keys are common enough on HLS, and
  // the stage is a kilobyte, so no HLS deployment should meet one unprepared.
  return [hlsCmaf(), hlsLive(), aes128()];
}
