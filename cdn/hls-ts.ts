import preset from '../src/presets/hls-ts/index.js';
import { baseFactories, hlsFactories, tsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, {
  ...hlsFactories,
  ...baseFactories,
  ...tsFactories,
});
