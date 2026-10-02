import preset from '../src/presets/dual-ts-drm/index.js';
import {
  baseFactories,
  dashFactories,
  drmFactories,
  hlsFactories,
  tsFactories,
} from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, {
  ...hlsFactories,
  ...dashFactories,
  ...baseFactories,
  ...tsFactories,
  ...drmFactories,
});
