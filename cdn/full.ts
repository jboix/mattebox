/** The full CDN bundle, `dist/cdn/mattebox.min.js`: the full preset behind the one global, with every stage factory. */
import preset from '../src/presets/full/index.js';
import {
  accessoryFactories,
  baseFactories,
  dashFactories,
  drmFactories,
  hlsLlFactories,
  tsFactories,
} from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, {
  ...hlsLlFactories,
  ...dashFactories,
  ...baseFactories,
  ...tsFactories,
  ...drmFactories,
  ...accessoryFactories,
});
