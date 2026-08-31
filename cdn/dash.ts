import preset from '../src/presets/dash/index.js';
import { baseFactories, dashFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...dashFactories, ...baseFactories });
