/**
 * One group of the preset matrix. Each group is its own module so a preset
 * imports only the groups it composes: a bundle that splits the presets into
 * lazy chunks then gives each preset its stages and no others. Each group is
 * a function so a preset gets fresh stage instances.
 */
import packedAudio from '../../containers/packed-audio/index.js';
import tsTransmux from '../../containers/ts-transmux/index.js';
import metaId3 from '../../stages/meta-id3/index.js';
import type { Stage } from '../../types/stage.js';

/**
 * Legacy MPEG-TS: the transmuxer and packed audio, plus ID3 metadata, which
 * rides on the transport stream. The transmuxer is also a caption source for
 * the base's text-cea608, next to nal-scan.
 */
export function tsTier(): Stage[] {
  return [tsTransmux(), packedAudio(), metaId3()];
}
