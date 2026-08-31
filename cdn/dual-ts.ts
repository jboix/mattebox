import preset from '../src/presets/dual-ts/index.js';
import { baseFactories, dashFactories, hlsFactories, tsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';
import { tsTransmux, withWorker } from './worker.js';

export default cdnGlobal(withWorker(preset), {
  ...hlsFactories,
  ...dashFactories,
  ...baseFactories,
  ...tsFactories,
  tsTransmux,
});
