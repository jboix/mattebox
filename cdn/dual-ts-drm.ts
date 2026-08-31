import preset from '../src/presets/dual-ts-drm/index.js';
import {
  baseFactories,
  dashFactories,
  drmFactories,
  hlsFactories,
  tsFactories,
} from './catalogue.js';
import { cdnGlobal } from './global.js';
import { tsTransmux, withWorker } from './worker.js';

export default cdnGlobal(withWorker(preset), {
  ...hlsFactories,
  ...dashFactories,
  ...baseFactories,
  ...tsFactories,
  tsTransmux,
  ...drmFactories,
});
