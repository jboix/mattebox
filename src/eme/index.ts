/**
 * The engine's DRM on an element the engine does not drive. On Safari a
 * player can play HLS natively with `video.src`; the element still fires
 * `encrypted` and needs a license. `attachEme` runs the same `eme-core` and
 * key-system stages the engine runs, on a small context of its own: the
 * element, `fetch` for licenses and certificates, and a local event bus.
 * Only the media route applies: init data comes from the element's
 * `encrypted` event, since there is no manifest the engine has parsed.
 */
import emeCore, { type DrmApi, type EmeOptions } from '../stages/eme-core/index.js';
import type { Listener, Stage, StageContext, Teardown, Unsubscribe } from '../types/stage.js';

export type { DrmApi, EmeOptions } from '../stages/eme-core/index.js';

/** An outgoing license or certificate request; a hook may rewrite both fields. */
export interface EmeRequestDraft {
  url: string;
  headers: Record<string, string>;
}

export interface AttachEmeOptions extends Omit<EmeOptions, 'releaseOnSuspend'> {
  /** Key systems to offer, such as `emeFairplay({ certificateUrl })`. ClearKey needs none. */
  readonly keySystems?: readonly Stage[];
  /** Rewrites license and certificate requests, for example to add an auth token. */
  readonly requestHook?: (request: EmeRequestDraft) => void;
}

export interface EmeAttachment {
  /** The key system and key statuses, the same API as `engine.drm`. */
  readonly drm: DrmApi;
  /** Listens to `drm:*` events and to `error`, which carries DRM failures. */
  on(event: string, fn: Listener): Unsubscribe;
  /** Closes every key session and clears the element's MediaKeys. */
  detach(): void;
}

const noop = (): void => {};

/** Starts DRM on the element. Call it before you set `src`, so no `encrypted` event is missed. */
export function attachEme(
  element: HTMLMediaElement,
  options: AttachEmeOptions = {},
): EmeAttachment {
  const { keySystems = [], requestHook, ...emeOptions } = options;
  const listeners = new Map<string, Set<Listener>>();
  let drm: DrmApi | undefined;

  const ctx: StageContext = {
    element,
    // eme-core is the only stage here that exposes an API.
    registerNamespace: (_name, api) => {
      drm = api as DrmApi;
    },
    request(url, init) {
      const draft: EmeRequestDraft = { url, headers: { ...init.headers } };
      requestHook?.(draft);
      return fetch(draft.url, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers: draft.headers,
        ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
      });
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set.add(fn));
      return () => set.delete(fn);
    },
    // The rest of the context serves an engine's pipeline, and none runs here.
    registerSink: noop,
    registerParser: noop,
    registerTransform: noop,
    registerChooser: noop,
    registerSwitchPolicy: noop,
    registerTypeProbe: noop,
    registerTimeProbe: noop,
    reduce: noop,
    dispatch: noop,
    addRequestHook: () => noop,
    addResponseHook: () => noop,
    capabilities: () => [],
    getState: () => {
      throw new Error('attachEme runs without an engine');
    },
  };

  // Key systems register their handlers first; eme-core reads them when it negotiates.
  const teardowns: Teardown[] = [];
  for (const stage of [...keySystems, emeCore(emeOptions)]) {
    const teardown = stage.install(ctx);
    if (typeof teardown === 'function') teardowns.push(teardown);
  }

  return {
    drm: drm as DrmApi,
    on: ctx.on,
    detach() {
      for (const teardown of teardowns.splice(0).reverse()) teardown();
      listeners.clear();
    },
  };
}
