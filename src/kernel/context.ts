/**
 * The StageContext implementation: everything a stage does to the engine
 * goes through this. Registrations land in the bus registries; namespaces
 * land on the facade object so an absent stage leaves no property behind,
 * not a stub that throws.
 */

import type { ContentType } from '../types/ir.js';
import type { SliceReducer } from '../types/kernel.js';
import type { AbrChooser, SwitchPolicy } from '../types/quality.js';
import type {
  StageContext,
  Teardown,
  TransformStep,
  TransportRequestDraftView,
  TypeProbe,
} from '../types/stage.js';
import type { KernelBus } from './bus.js';

/** The mutable hook registry the reducer reads through; shared across contexts. */
export interface HookRegistry {
  abr?: AbrChooser | null;
  switchPolicy?: SwitchPolicy | null;
  /** Reads a SourceBuffer type from init bytes, for renditions the manifest left codec-less. */
  typeProbe?: TypeProbe | null;
  /** The composition's manifest MIME types; static, set by the composition root. */
  readonly manifestTypes?: ReadonlySet<string>;
}

export interface ContextDeps {
  readonly bus: KernelBus;
  readonly element: HTMLMediaElement;
  /** The facade object namespaces attach to. */
  readonly facade: Record<string, unknown>;
  /** Live slice list; the reducer reads it through the bus after install. */
  readonly slices: Array<readonly [string, SliceReducer]>;
  readonly hooks: HookRegistry;
  /** Registers a transport request hook; returns the unsubscribe. */
  readonly addRequestHook: (hook: (req: TransportRequestDraftView) => void) => () => void;
  /** A one-off request through the transport. */
  readonly request: (
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: ArrayBuffer | Uint8Array | string;
    },
  ) => Promise<Response>;
}

/**
 * Builds one stage's context and returns the registrations' own teardown,
 * combined by the caller with whatever the stage's install returns.
 */
export function createStageContext(deps: ContextDeps): { ctx: StageContext; teardown: Teardown } {
  const unsubscribes: Array<() => void> = [];
  const namespaceNames: string[] = [];
  // Every registry entry this stage made, undone at teardown so that a
  // detach followed by an attach (a media-error rebuild, an element swap)
  // installs the stage afresh instead of tripping the duplicate guards or
  // running a transform twice.
  const sinkTypes: ContentType[] = [];
  const parserTypes: string[] = [];
  const transformSteps: TransformStep[] = [];
  let registeredChooser = false;
  let registeredPolicy = false;
  let registeredProbe = false;

  const ctx: StageContext = {
    element: deps.element,
    registerSink(contentType, factory) {
      deps.bus.registerSink(contentType, factory as never);
      sinkTypes.push(contentType);
    },
    registerParser(mimeType, parse) {
      deps.bus.registerParser(mimeType, parse);
      parserTypes.push(mimeType);
    },
    registerTransform(step) {
      // Ordering is declared on the step, not emergent from registration
      // order; the bus keeps the pipeline sorted by `order`.
      deps.bus.registerTransform(step);
      transformSteps.push(step);
    },
    getState() {
      return deps.bus.getState();
    },
    addRequestHook(hook) {
      const off = deps.addRequestHook(hook);
      unsubscribes.push(off);
      return off;
    },
    request(url, init) {
      return deps.request(url, init);
    },
    registerNamespace(name, api) {
      deps.bus.registerNamespace(name, api);
      deps.facade[name] = api;
      namespaceNames.push(name);
    },
    registerChooser(chooser) {
      if (deps.hooks.abr != null) {
        throw new Error('an abr chooser is already registered');
      }
      deps.hooks.abr = chooser;
      registeredChooser = true;
    },
    registerSwitchPolicy(policy) {
      if (deps.hooks.switchPolicy != null) {
        throw new Error('a switch policy is already registered');
      }
      deps.hooks.switchPolicy = policy;
      registeredPolicy = true;
    },
    registerTypeProbe(probe) {
      if (deps.hooks.typeProbe != null) {
        throw new Error('a type probe is already registered');
      }
      deps.hooks.typeProbe = probe;
      registeredProbe = true;
    },
    reduce(slice, reducer) {
      deps.slices.push([slice, reducer as SliceReducer]);
    },
    dispatch(cmd) {
      deps.bus.dispatch(cmd);
    },
    emit(event, payload) {
      deps.bus.emitEvent(event, payload);
    },
    on(event, fn) {
      const off = deps.bus.on(event, fn);
      unsubscribes.push(off);
      return off;
    },
  };

  return {
    ctx,
    teardown() {
      for (const off of unsubscribes) off();
      for (const name of namespaceNames) {
        delete deps.facade[name];
        deps.bus.unregisterNamespace(name);
      }
      for (const contentType of sinkTypes) deps.bus.unregisterSink(contentType);
      for (const mimeType of parserTypes) deps.bus.unregisterParser(mimeType);
      for (const step of transformSteps) deps.bus.unregisterTransform(step);
      if (registeredChooser) deps.hooks.abr = null;
      if (registeredPolicy) deps.hooks.switchPolicy = null;
      if (registeredProbe) deps.hooks.typeProbe = null;
    },
  };
}
