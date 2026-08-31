/**
 * codec-switch: the real answer to entanglement #2's query. It registers a
 * switch policy the kernel injects into abr's telemetry; abr consumes it
 * without importing this stage. The refinement over the kernel default: a
 * changeType verdict is only returned when the browser can actually bridge
 * the two codecs, which needs both a supported target type and
 * SourceBuffer.changeType itself. Where the browser cannot, an in-family
 * change downgrades to reload rather than proposing a switch that would
 * throw at append time.
 *
 * codec-probe (declared in `requires`, resolved by the loader, never
 * imported) is the future source of exact codec strings when a manifest
 * lies; until a runtime call site exists this policy reasons over the IR's
 * declared strings, which is already a real improvement.
 */
import { canSwitchTo } from '../../kernel/rendition-select.js';
import type { Rendition } from '../../types/ir.js';
import type { SwitchVerdict } from '../../types/quality.js';
import type { Stage } from '../../types/stage.js';

/** A full MSE type string for a rendition, mime plus codecs. */
function typeString(rendition: Rendition): string {
  return rendition.codecs === null
    ? rendition.mimeType
    : `${rendition.mimeType}; codecs="${rendition.codecs}"`;
}

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
  return MediaSourceCtor.isTypeSupported(typeString(target));
}

export function createPolicy(): (current: Rendition | null, target: Rendition) => SwitchVerdict {
  return (current, target) => {
    const base = canSwitchTo(current, target);
    if (base !== 'changeType') return base;
    // The kernel says a changeType would do; confirm the browser agrees.
    return changeTypeSupported(target) ? 'changeType' : 'reload';
  };
}

export default function codecSwitch(): Stage {
  return {
    name: 'codec-switch',
    provides: ['codec-switch'],
    // docs/05 also lists codec-probe; that becomes a real `requires` once
    // the probe has a runtime call site (tracked in the register). Until
    // then this policy reasons over declared strings and needs only mse's
    // changeType.
    requires: ['mse'],
    install(ctx) {
      ctx.registerSwitchPolicy(createPolicy());
    },
  };
}
