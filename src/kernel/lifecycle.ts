/**
 * Attach and detach, the docs-09 sequences, orchestrating the mse
 * controller, the stage loader, and element listeners. The element itself
 * is never modified beyond what attachment requires: autoplay untouched,
 * no member shadowed, nothing monkey-patched.
 */

import type { TimeRangesSnapshot } from '../types/ir.js';
import type { KernelConfig, SliceReducer } from '../types/kernel.js';
import type { Fact } from '../types/messages.js';
import type { Stage, TransportRequestDraftView } from '../types/stage.js';
import type { KernelBus } from './bus.js';
import type { HookRegistry } from './context.js';
import { createStageContext } from './context.js';
import type { Composition } from './loader.js';
import type { MseController } from './mse.js';
import { createReducer } from './reducer.js';
import { createPlaybackWatchdog } from './watchdog.js';

export interface LifecycleDeps {
  readonly bus: KernelBus;
  readonly mse: MseController;
  readonly composition: Composition;
  readonly facade: Record<string, unknown>;
  readonly config: Partial<KernelConfig> | undefined;
  /** Shared mutable registry: stages set hooks at install, the reducer reads them live. */
  readonly hooks: HookRegistry;
  /** Transport request-hook registration, passed to stage contexts. */
  readonly addRequestHook: (hook: (req: TransportRequestDraftView) => void) => () => void;
  /** A one-off transport request, passed to stage contexts. */
  readonly request: (
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: ArrayBuffer | Uint8Array | string;
    },
  ) => Promise<Response>;
  /** WeakMap registration, owned by the package entry. */
  readonly register: (el: HTMLMediaElement) => void;
  readonly unregister: (el: HTMLMediaElement) => void;
  /** The element reported a media error; the package entry decides whether to rebuild. */
  readonly onMediaError?: (el: HTMLMediaElement) => void;
}

export interface Lifecycle {
  attach(el: HTMLMediaElement): void;
  detach(): void;
  element(): HTMLMediaElement | null;
}

function snapshot(ranges: TimeRanges): TimeRangesSnapshot {
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < ranges.length; i += 1) {
    out.push({ start: ranges.start(i), end: ranges.end(i) });
  }
  return out;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  let element: HTMLMediaElement | null = null;
  let teardowns: Array<() => void> = [];
  let stopWatchdog: (() => void) | null = null;
  const elementListeners: Array<{ type: string; fn: EventListener }> = [];

  function listen(el: HTMLMediaElement, type: string, fn: EventListener): void {
    el.addEventListener(type, fn);
    elementListeners.push({ type, fn });
  }

  function attach(el: HTMLMediaElement): void {
    if (element !== null) {
      throw Object.assign(new Error('this engine is already attached'), {
        category: 'config',
        code: 'CONFIG_ELEMENT_OCCUPIED',
      });
    }

    // Compose the stages first: a composition error must leave the element
    // untouched. Slices collected here rebuild the reducer below.
    const slices: Array<readonly [string, SliceReducer]> = [];
    const stageTeardowns: Array<() => void> = [];
    for (const stage of deps.composition.order) {
      const { ctx, teardown } = createStageContext({
        bus: deps.bus,
        element: el,
        facade: deps.facade,
        slices,
        hooks: deps.hooks,
        addRequestHook: deps.addRequestHook,
        request: deps.request,
      });
      const returned = (stage as Stage).install(ctx);
      // Reverse order on teardown: the context cleanup runs after the
      // stage's own teardown, mirroring construction.
      if (typeof returned === 'function') stageTeardowns.push(returned);
      stageTeardowns.push(teardown);
    }
    deps.bus.setReducer(createReducer(slices, deps.config, deps.hooks));
    teardowns = stageTeardowns;

    deps.bus.dispatch({ type: 'ATTACH', element: el });
    // The mse controller runs the element-level sequence: occupancy check,
    // resource-selection reset, ManagedMediaSource preference, srcObject
    // with revoke-at-sourceopen fallback. autoplay is never touched.
    try {
      deps.mse.attach(el);
    } catch (err) {
      for (const fn of [...teardowns].reverse()) fn();
      teardowns = [];
      deps.bus.dispatch({ type: 'DETACH' });
      throw err;
    }
    element = el;

    const absorb = (fact: Fact): void => deps.bus.absorb(fact);
    listen(el, 'timeupdate', () => {
      absorb({
        type: 'TIME_UPDATE',
        currentTime: el.currentTime,
        buffered: snapshot(el.buffered),
        // Wall time enters the loop here, at the boundary; live stages
        // slide their windows on it and the reducer never reads a clock.
        wallClock: Date.now() / 1000,
      });
    });
    listen(el, 'ended', () => {
      absorb({ type: 'ENDED', at: el.currentTime });
    });
    listen(el, 'seeking', () => {
      absorb({ type: 'SEEKING', to: el.currentTime });
    });
    listen(el, 'seeked', () => {
      absorb({ type: 'SEEKED', at: el.currentTime });
    });
    listen(el, 'waiting', () => {
      absorb({ type: 'STALLED', at: el.currentTime, buffered: snapshot(el.buffered) });
    });
    listen(el, 'error', () => {
      deps.onMediaError?.(el);
    });
    // The clock-driven twin of the waiting listener, for the stalls the
    // browser never announces.
    stopWatchdog = createPlaybackWatchdog(el, absorb);

    deps.register(el);
  }

  function detach(): void {
    if (element === null) return;
    const el = element;

    // Order per docs/09: stop the world (aborts ride the DETACH effects),
    // tear down stages in reverse install order, then release the element.
    deps.bus.dispatch({ type: 'DETACH' });
    stopWatchdog?.();
    stopWatchdog = null;
    for (const fn of [...teardowns].reverse()) {
      fn();
    }
    teardowns = [];
    deps.mse.detach();
    for (const { type, fn } of elementListeners) {
      el.removeEventListener(type, fn);
    }
    elementListeners.length = 0;
    deps.unregister(el);
    element = null;
  }

  return {
    attach,
    detach,
    element: () => element,
  };
}
