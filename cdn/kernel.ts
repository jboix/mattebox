import preset from '../src/presets/kernel/index.js';
import { cdnGlobal } from './global.js';

// The engine alone: the factory and the empty preset.
export default cdnGlobal(preset, {});
