import preset from '../src/presets/dual-ll/index.js';
import {
  baseFactories,
  dashLlFactories,
  hlsLlFactories,
  lowLatencyFactories,
} from './catalogue.js';
import { cdnGlobal } from './global.js';

export default cdnGlobal(preset, {
  ...hlsLlFactories,
  ...dashLlFactories,
  ...lowLatencyFactories,
  ...baseFactories,
});
