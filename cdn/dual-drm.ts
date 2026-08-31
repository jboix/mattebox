import preset from '../src/presets/dual-drm/index.js';
import { baseFactories, dashFactories, drmFactories, hlsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, {
  ...hlsFactories,
  ...dashFactories,
  ...baseFactories,
  ...drmFactories,
});
