import preset from '../src/presets/hls-ll/index.js';
import { baseFactories, hlsLlFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...hlsLlFactories, ...baseFactories });
