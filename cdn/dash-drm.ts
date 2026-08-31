import preset from '../src/presets/dash-drm/index.js';
import { baseFactories, dashFactories, drmFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...dashFactories, ...baseFactories, ...drmFactories });
