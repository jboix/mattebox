import preset from '../src/presets/dash-ll/index.js';
import { baseFactories, dashLlFactories, lowLatencyFactories } from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, { ...dashLlFactories, ...lowLatencyFactories, ...baseFactories });
