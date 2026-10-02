import preset from '../src/presets/dual-ts/index.js';
import { baseFactories, dashFactories, hlsFactories, tsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, {
  ...hlsFactories,
  ...dashFactories,
  ...baseFactories,
  ...tsFactories,
});
