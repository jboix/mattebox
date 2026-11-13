/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */
import emeCenc from '../../stages/eme-cenc/index.js';
import emeCore from '../../stages/eme-core/index.js';
import emeFairplay from '../../stages/eme-fairplay/index.js';
import type { Stage } from '../../types/stage.js';

/** The EME stages: sessions, CENC (Widevine, PlayReady, ClearKey), FairPlay. */
export function drmTier(): Stage[] {
  return [emeCore(), emeCenc(), emeFairplay()];
}
