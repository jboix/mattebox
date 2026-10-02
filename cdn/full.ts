/** The full CDN bundle, `dist/cdn/mattebox.min.js`: every stage of the full preset behind the one global. */
import preset from '../src/presets/full/index.js';
import {
  accessoryFactories,
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
  ...accessoryFactories,
});
