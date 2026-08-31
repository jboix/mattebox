/**
 * mp4-box as a loadable stage. The walker is a container-layer library used
 * across the engine; this stage exposes it on the facade as `engine.mp4box`
 * so a composition can inspect ISOBMFF box trees at runtime, which is what the
 * playground uses to make the module observable rather than a silent
 * dependency. Loading it also declares the `mp4-box` capability that
 * codec-probe and the DASH addressing stages resolve against.
 */
import {
  findBox,
  findBoxes,
  parseSidx,
  parseTfdt,
  walkBoxes,
} from '../../containers/mp4-box/index.js';
import type { Stage } from '../../types/stage.js';

export default function mp4Box(): Stage {
  return {
    name: 'mp4-box',
    provides: ['mp4-box'],
    install(ctx) {
      ctx.registerNamespace('mp4box', { walkBoxes, findBox, findBoxes, parseTfdt, parseSidx });
    },
  };
}
