/**
 * codec-switch: the real answer to entanglement #2's query. It registers a
 * switch policy the kernel injects into abr's telemetry; abr consumes it
 * without importing this stage. The refinement over the kernel default,
 * which reloads across codec families: a family change is a changeType
 * when the browser can actually bridge the two codecs, which needs both a
 * supported target type and SourceBuffer.changeType itself, and a reload
 * where it cannot. Changes inside one family stay seamless, as the kernel
 * says: the reducer appends the new init bare and browsers accept it.
 *
 * codec-probe (declared in `requires`, resolved by the loader, never
 * imported) is the future source of exact codec strings when a manifest
 * lies; until a runtime call site exists this policy reasons over the IR's
 * declared strings, which is already a real improvement.
 */
import { typeString } from '../../kernel/mime.js';
import { canSwitchTo } from '../../kernel/rendition-select.js';
import type { Rendition } from '../../types/ir.js';
import type { SwitchVerdict } from '../../types/quality.js';
import type { Stage } from '../../types/stage.js';

/** Whether the runtime can bridge two types without tearing the buffer down. */
function changeTypeSupported(target: Rendition): boolean {
  const MediaSourceCtor =
    typeof MediaSource !== 'undefined'
      ? MediaSource
      : (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  if (MediaSourceCtor === undefined) return false;
  if (
    typeof (globalThis.SourceBuffer?.prototype as { changeType?: unknown })?.changeType !==
    'function'
  ) {
    return false;
  }
  return MediaSourceCtor.isTypeSupported(typeString(target.mimeType, target.codecs));
}

export function createPolicy(): (current: Rendition | null, target: Rendition) => SwitchVerdict {
  return (current, target) => {
    if (canSwitchTo(current, target) === 'seamless') return 'seamless';
    // A family change: changeType where the browser bridges it, else reload.
    return changeTypeSupported(target) ? 'changeType' : 'reload';
  };
}

export default function codecSwitch(): Stage {
  return {
    name: 'codec-switch',
    provides: ['codec-switch'],
    // The design also lists codec-probe; that becomes a real `requires` once
    // the probe has a runtime call site (tracked in the register). Until
    // then this policy reasons over declared strings and needs only mse's
    // changeType.
    requires: ['mse'],
    install(ctx) {
      ctx.registerSwitchPolicy(createPolicy());
    },
  };
}
