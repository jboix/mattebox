import preset from '../src/presets/hls-ts-drm/index.js';
import { baseFactories, drmFactories, hlsFactories, tsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, {
  ...hlsFactories,
  ...baseFactories,
  ...tsFactories,
  ...drmFactories,
});
