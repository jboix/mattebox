import preset from '../src/presets/kernel/index.js';
import { cdnGlobal } from './global.js';

// The engine alone: no stages, so nothing hangs off the global but the
// factory and the empty preset. The floor the size chart draws.
export default cdnGlobal(preset, {});
