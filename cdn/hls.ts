import preset from '../src/presets/hls/index.js';
import { baseFactories, hlsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...hlsFactories, ...baseFactories });
