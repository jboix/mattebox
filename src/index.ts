/**
 * Mattebox: a modular adaptive-streaming engine for HLS and DASH.
 * The public entry: the mattebox() factory composes the kernel with the
 * caller's stages; mattebox.from() finds an engine from its element. One
 * name for both, so the ESM import and the CDN global read the same.
 */
import { createBus } from './kernel/bus.js';
import type { HookRegistry } from './kernel/context.js';
import { createEffectRunner } from './kernel/effects.js';
import { createLifecycle } from './kernel/lifecycle.js';
import { compose } from './kernel/loader.js';
import { normalizeMimeType } from './kernel/mime.js';
import { createMseController } from './kernel/mse.js';
import { createReducer, initialState, resolveConfig } from './kernel/reducer.js';
import { createArbiter } from './kernel/rendition-select.js';
import { createMseSink } from './kernel/sinks/mse-sink.js';
import type { CueSink } from './kernel/sinks/text-track-sink.js';
import { createTrackRegistry } from './kernel/track-registry.js';
import { createTransport } from './kernel/transport.js';
import type { MatteboxBase, MatteboxOptions } from './types/facade.js';
import type { ContentType, Rendition } from './types/ir.js';
import type { KernelConfig, TracedError } from './types/kernel.js';

// Diagnosability is a project goal: the trace tooling is public API. A
// production trace replays into a fresh reducer as a regression test.
export { createReducer, initialState, resolveConfig } from './kernel/reducer.js';
// The kernel's default answer to entanglement #2; the abr stage consumes it.
export { canSwitchTo } from './kernel/rendition-select.js';
export { exportTrace, replay } from './kernel/trace.js';

export type * from './types/error.js';
export type * from './types/facade.js';
export type * from './types/ir.js';
export type * from './types/kernel.js';
export type * from './types/messages.js';
export type * from './types/quality.js';
export type * from './types/sink.js';
export type * from './types/stage.js';

/**
 * Namespaces contributed by stages. Empty here on purpose: a stage's module
 * augments this interface (declaration merging) so that, for example,
 * `engine.live` is typed exactly when `hls-live` or `dash-live` is loaded.
 * Without the merge the property does not exist, matching the runtime, where
 * an absent stage leaves no stub behind.
 */
// biome-ignore lint/suspicious/noEmptyInterface: the declaration-merging target for stage namespaces
export interface MatteboxNamespaces {}

/**
 * The engine facade. Namespace members are optional because presence
 * depends on the loaded stages; `'live' in engine` is the feature test.
 */
export type Mattebox = MatteboxBase & Partial<MatteboxNamespaces>;

const registry = new WeakMap<HTMLMediaElement, Mattebox>();

/** Creates an engine. The element is supplied later via `attach`. */
export function mattebox(options: MatteboxOptions): Mattebox {
  const composition = compose(options.stages ?? []);
  // A timing transform makes media time equal presentation time; the
  // scheduler must know, or a discontinuity gets re-anchored twice.
  const config: Partial<KernelConfig> = {
    ...options.config,
    mediaTimeNormalized:
      options.config?.mediaTimeNormalized ??
      composition.capabilities.includes('media-time-normalized'),
  };
  const cfg = resolveConfig(config);

  const bus = createBus({
    reducer: createReducer([], config),
    initial: initialState(config),
    traceCapacity: cfg.traceCapacity,
  });
  const runner = createEffectRunner({ onEvent: (event, payload) => bus.emitEvent(event, payload) });
  bus.setEffectSink((effects) => runner.run(effects));

  // A transform pipeline routes media bytes through registerTransform steps
  // before the SourceBuffer, exactly as the deliver effect routes cue bytes.
  // Wired only when the composition actually registered a transform, so a
  // CMAF composition keeps the direct-enqueue append path untouched.
  const mediaTransforms = composition.capabilities.includes('media-transform');
  const mse = createMseController({
    absorb: (fact) => bus.absorb(fact),
    backBufferSeconds: cfg.backBufferSeconds,
    // A codec-less rendition's buffer is typed from its first segment,
    // when a stage registered a probe; without one the bare type is tried.
    inferType: (bytes) => hooks.typeProbe?.(bytes) ?? null,
    ...(mediaTransforms
      ? {
          appendTransform: async (data, meta) => {
            let out = data;
            for (const step of bus.transforms()) {
              out = new Uint8Array(await step.transform(out, meta));
            }
            return out;
          },
        }
      : {}),
  });
  mse.registerHandlers(runner);

  const transport = createTransport({
    absorb: (fact) => bus.absorb(fact),
    inflight: (token) => bus.getState().scheduling.inflight.get(token),
    // A media Content-Type on the manifest response that no adapter parses
    // (an mp3, a progressive mp4) is refused before the body downloads.
    // Anything else, including octet-stream, downloads and is sniffed.
    acceptManifestType: (contentType) => {
      const type = normalizeMimeType(contentType);
      return !(type.startsWith('audio/') || type.startsWith('video/')) || accepts(type);
    },
    ...(options.transport?.retry !== undefined ? { retry: options.transport.retry } : {}),
    ...(options.transport?.fetchImpl !== undefined
      ? { fetchImpl: options.transport.fetchImpl }
      : {}),
  });
  transport.registerHandlers(runner);
  for (const hook of options.transport?.requestHooks ?? []) transport.addRequestHook(hook);
  for (const hook of options.transport?.responseHooks ?? []) transport.addResponseHook(hook);

  runner.register('emit', (effect) => {
    bus.emitEvent(effect.event, effect.payload);
    return undefined;
  });
  runner.register('schedule', (effect) => {
    const id = setTimeout(() => {
      runner.forget(effect.token);
      // Ticks carry the wall time of their firing: the one clock input a
      // pure slice can loop itself.
      const msg =
        effect.then.type === 'TICK'
          ? { ...effect.then, wallClock: Date.now() / 1000 }
          : effect.then;
      bus.route(msg);
    }, effect.delayMs);
    return () => clearTimeout(id);
  });
  runner.register('seekElement', (effect) => {
    const el = lifecycle.element();
    if (el !== null) el.currentTime = effect.to;
    return undefined;
  });
  // Cue sinks arrive from stages as factories; the kernel instantiates one
  // per content type at first use, against the attached element, so the
  // emitCues, deliver, and clearCues effects have a live target. Cleared on
  // detach with the element.
  const cueSinks = new Map<ContentType, CueSink<'text' | 'metadata'>>();
  function cueSinkFor(contentType: ContentType): CueSink<'text' | 'metadata'> | null {
    const existing = cueSinks.get(contentType);
    if (existing !== undefined) return existing;
    const el = lifecycle.element();
    if (el === null) return null;
    const factory = bus.sinkFor(contentType);
    if (factory === undefined) return null;
    const sink = factory({ element: el }) as unknown as CueSink<'text' | 'metadata'>;
    cueSinks.set(contentType, sink);
    return sink;
  }

  function contentTypeOfTrack(trackId: string): ContentType | null {
    for (const period of bus.getState().presentation?.periods ?? []) {
      for (const track of period.tracks) {
        if (track.id === trackId) return track.contentType;
      }
    }
    return null;
  }

  runner.register('emitCues', (effect) => {
    const contentType = contentTypeOfTrack(effect.trackId);
    if (contentType !== 'text' && contentType !== 'metadata') return undefined;
    cueSinkFor(contentType)?.handleEmitCues(effect.trackId, effect.cues);
    return undefined;
  });

  // Byte delivery for cue pipelines: transforms in declared order, then the
  // sink parses and answers with effects. A per-engine chain keeps segment
  // order even when a transform is asynchronous.
  let deliverChain: Promise<void> = Promise.resolve();
  runner.register('deliver', (effect) => {
    const sink = cueSinkFor(effect.contentType);
    if (sink === null) return undefined;
    deliverChain = deliverChain
      .then(async () => {
        let data: Uint8Array = new Uint8Array(effect.data);
        for (const step of bus.transforms()) {
          data = new Uint8Array(await step.transform(data, effect.meta));
        }
        const bytes =
          data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
            ? (data.buffer as ArrayBuffer)
            : (data.slice().buffer as ArrayBuffer);
        const produced = sink.accept(effect.trackId, bytes, effect.meta);
        if (produced.length > 0) runner.run(produced);
      })
      .catch(() => {
        // A cue pipeline degrades; playback is untouched.
        bus.emitEvent('error', {
          category: 'media',
          code: 'MEDIA_CONTAINER_INVALID',
          fatal: false,
          recoverable: false,
          trackId: effect.trackId,
        });
      });
    return undefined;
  });

  runner.register('clearCues', (effect) => {
    for (const sink of cueSinks.values()) {
      sink.clear(effect.trackId, effect.start, effect.end);
    }
    return undefined;
  });

  // The kernel owns the media sinks; stages own text and metadata.
  const sinkInstances = new Map<ContentType, object>();
  for (const contentType of ['video', 'audio'] as const) {
    const sink = createMseSink(contentType, { buffered: (sbId) => mse.buffered(sbId) });
    sinkInstances.set(contentType, sink);
    bus.registerSink(contentType, () => sink);
  }
  for (const capability of composition.capabilities) {
    bus.registerCapability(capability);
  }

  const tracks = createTrackRegistry({
    getState: () => bus.getState(),
    dispatch: (cmd) => bus.dispatch(cmd),
    emitEvent: (event, payload) => bus.emitEvent(event, payload),
    hasSink: (contentType) => bus.sinkFor(contentType) !== undefined,
  });

  const arbiter = createArbiter();
  // Shared with the stage contexts: the abr stage sets `abr` at install and
  // the reducer reads it live through this object.
  const hooks: HookRegistry = { manifestTypes: composition.manifestTypes };
  let lastError: TracedError | null = null;

  function accepts(mimeType: string): boolean {
    return composition.manifestTypes.has(normalizeMimeType(mimeType));
  }

  function activeVideoRenditions(): readonly Rendition[] {
    const state = bus.getState();
    if (state.presentation === null) return [];
    const activeId = state.tracks.active.get('video');
    for (const period of state.presentation.periods) {
      for (const track of period.tracks) {
        if (track.contentType !== 'video') continue;
        if (activeId === undefined || track.id === activeId) return track.renditions;
      }
    }
    return [];
  }

  function arbitrated() {
    const state = bus.getState();
    return arbiter.run(
      {
        renditions: activeVideoRenditions(),
        constraints: state.quality.constraints,
        pinned: state.quality.pinned,
        current: state.quality.active,
        couplings: state.presentation?.couplings ?? [],
        activeTracks: state.tracks.active,
        availableGroups: (() => {
          const groups = new Set<string>();
          for (const period of state.presentation?.periods ?? []) {
            for (const track of period.tracks) {
              if (track.contentType !== 'audio' && track.contentType !== 'text') continue;
              const colon = track.id.indexOf(':');
              groups.add(
                `${track.contentType}:${colon === -1 ? track.id : track.id.slice(0, colon)}`,
              );
            }
          }
          return groups;
        })(),
        telemetry: {
          throughputEwma: state.stats.throughputEwma,
          throughputFastEwma: state.stats.throughputFastEwma,
          current: state.quality.active,
          currentTime: state.playback.currentTime,
        },
      },
      state.quality.version,
    );
  }

  const facadeTarget: Record<string, unknown> = {};

  // The element's own error (a decoder that gave up, a source the browser
  // rejects) is reported as a fatal engine error, never papered over by a
  // reload: a rebuilt pipeline restarts playback visibly, which is worse
  // than an honest error. In-place recovery (nudges, gap jumps, flushes,
  // skips, rendition exclusion) is the recovery stage's job and happens
  // before the decoder ever fails.
  const MEDIA_ERR = [
    '',
    'MEDIA_ERR_ABORTED',
    'MEDIA_ERR_NETWORK',
    'MEDIA_ERR_DECODE',
    'MEDIA_ERR_SRC_NOT_SUPPORTED',
  ];

  function onMediaError(el: HTMLMediaElement): void {
    const code = el.error?.code ?? 0;
    // An abort is the app's doing; an engine that already halted keeps its error.
    if (code === 1 || lastError !== null) return;
    bus.emitEvent('error', {
      category: 'media',
      code: code === 4 ? 'MEDIA_CODEC_UNSUPPORTED' : 'MEDIA_DECODE_ERROR',
      fatal: true,
      recoverable: false,
      context: { mediaError: MEDIA_ERR[code] ?? code, message: el.error?.message ?? '' },
    });
  }

  const base: MatteboxBase = {
    get media() {
      return lifecycle.element();
    },
    quality: {
      get renditions() {
        return activeVideoRenditions();
      },
      get allowed() {
        const ids = arbitrated().result.allowed;
        return activeVideoRenditions().filter((r) => ids.includes(r.id));
      },
      get active() {
        const id = bus.getState().quality.active;
        return activeVideoRenditions().find((r) => r.id === id) ?? null;
      },
      get playing() {
        const state = bus.getState();
        const id = arbiter.playingAt(state.quality.appendLog, state.playback.currentTime);
        return activeVideoRenditions().find((r) => r.id === id) ?? null;
      },
      get pinned() {
        return bus.getState().quality.pinned;
      },
      get constraints() {
        return bus.getState().quality.constraints;
      },
      constrain(source, constraint) {
        bus.dispatch({ type: 'CONSTRAIN', source, constraint });
      },
      release(source) {
        bus.dispatch({ type: 'RELEASE_CONSTRAINT', source });
      },
      pin(renditionId, pinOptions) {
        bus.dispatch({
          type: 'PIN_RENDITION',
          renditionId,
          apply: pinOptions?.apply ?? 'soon',
        });
      },
      auto() {
        bus.dispatch({ type: 'RELEASE_PIN' });
      },
    },
    tracks,
    stats: {
      get throughput() {
        return bus.getState().stats.throughputEwma;
      },
      trace() {
        return bus.trace();
      },
      snapshot() {
        return bus.getState();
      },
    },
    get error() {
      return lastError;
    },
    async attach(el) {
      // async so a synchronous composition or occupancy error surfaces as
      // a rejection, matching the declared Promise contract.
      lifecycle.attach(el);
    },
    async detach() {
      lifecycle.detach();
    },
    load(url, loadOptions) {
      // Consumers hand over page-relative URLs; the IR stores absolute ones
      // and parsers resolve against the manifest URL, so absolutize here.
      let absolute = url;
      try {
        absolute = new URL(url, globalThis.location?.href).href;
      } catch {
        // No document base (tests, workers): the caller's URL stands.
      }
      lastError = null;
      // A load replaces whatever is loaded, the way setting `src` does.
      const { phase } = bus.getState().lifecycle;
      if (phase !== 'idle' && phase !== 'attaching') bus.dispatch({ type: 'UNLOAD' });
      bus.dispatch({
        type: 'LOAD',
        url: absolute,
        ...(loadOptions?.mimeType !== undefined ? { mimeType: loadOptions.mimeType } : {}),
      });
    },
    unload() {
      bus.dispatch({ type: 'UNLOAD' });
    },
    dispatch(cmd) {
      bus.dispatch(cmd);
    },
    capabilities() {
      return composition.capabilities.map((capability) =>
        typeof capability === 'string'
          ? capability
          : `${capability.contentType}:${capability.mimeType}`,
      );
    },
    accepts,
    on(event, fn) {
      return bus.on(event, fn);
    },
  };

  bus.on('error', (payload) => {
    const summary = payload as Partial<TracedError>;
    if (summary.fatal === true) {
      lastError = {
        category: summary.category ?? 'internal',
        code: summary.code ?? 'INTERNAL_ASSERTION',
        fatal: true,
        recoverable: summary.recoverable ?? false,
        trace: bus.trace(),
      };
    }
  });

  // Copy descriptors, not values: Object.assign would evaluate every live
  // getter once and freeze the result.
  Object.defineProperties(facadeTarget, Object.getOwnPropertyDescriptors(base));
  const engine = facadeTarget as unknown as Mattebox;

  const lifecycle = createLifecycle({
    bus,
    mse,
    composition,
    facade: facadeTarget,
    config,
    hooks,
    addRequestHook: (hook) => transport.addRequestHook(hook),
    request: (url, init) => transport.request(url, init),
    register: (el) => registry.set(el, engine),
    unregister: (el) => {
      registry.delete(el);
      // Nothing started before the detach may land after it: pending
      // timers and fetches go, and the cue sinks release their native
      // tracks (the element cannot drop a TextTrack, so they empty them).
      runner.cancelAll();
      for (const sink of cueSinks.values()) sink.dispose();
      cueSinks.clear();
    },
    onMediaError,
  });

  return engine;
}

/**
 * Static lookup from an element to its engine, backed by a WeakMap. The
 * element itself carries no added surface and garbage-collects normally.
 */
mattebox.from = (el: HTMLMediaElement): Mattebox | null => registry.get(el) ?? null;
