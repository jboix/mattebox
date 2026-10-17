import preset from '../src/presets/dual-ll/index.js';
import { baseFactories, dashFactories, hlsLlFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...hlsLlFactories, ...dashFactories, ...baseFactories });
