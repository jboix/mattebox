import preset from '../src/presets/dual/index.js';
import { baseFactories, dashFactories, hlsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...hlsFactories, ...dashFactories, ...baseFactories });
