import preset from '../src/presets/hls-ts/index.js';
import { baseFactories, hlsFactories, tsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';
import { tsTransmux, withWorker } from './worker.js';

export default cdnGlobal(withWorker(preset), {
  ...hlsFactories,
  ...baseFactories,
  ...tsFactories,
  tsTransmux,
});
