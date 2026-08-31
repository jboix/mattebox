import preset from '../src/presets/hls-drm/index.js';
import { baseFactories, drmFactories, hlsFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...hlsFactories, ...baseFactories, ...drmFactories });
