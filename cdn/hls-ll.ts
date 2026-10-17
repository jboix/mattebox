import preset from '../src/presets/hls-ll/index.js';
import { baseFactories, hlsLlFactories, lowLatencyFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...hlsLlFactories, ...lowLatencyFactories, ...baseFactories });
