/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */
import hlsLl from '../../protocols/hls-ll/index.js';
import aes128 from '../../stages/aes-128/index.js';
import type { Stage } from '../../types/stage.js';

/**
 * Low-latency HLS: hls-ll in place of hls-cmaf and hls-live, which it
 * contains. A playlist without parts plays as the HLS line plays it.
 */
export function hlsLlLine(): Stage[] {
  return [hlsLl(), aes128()];
}
