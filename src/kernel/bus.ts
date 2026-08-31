/**
 * The message loop. One queue serializes the five concurrent writers; every
 * classic player bug is an interleaving bug, and this is the fix.
 *
 * Reentrancy: a listener dispatching from inside the flush enqueues; it
 * never recurses. Messages are processed strictly in arrival order.
 */
import type { ContentType } from '../types/ir.js';
import type { Bus, KernelState, Reducer, TraceEntry } from '../types/kernel.js';
import type { Command, Effect, Fact, Message } from '../types/messages.js';
import type {
  Capability,
  Listener,
  ParserFn,
  SinkFactory,
  TransformStep,
  Unsubscribe,
} from '../types/stage.js';
import { createTraceBuffer, DEFAULT_TRACE_CAPACITY, digest } from './trace.js';

export interface CreateBusOptions {
  readonly reducer: Reducer;
  readonly initial: KernelState;
  /** Clock for trace timestamps. The reducer itself never sees it. */
  readonly now?: () => number;
  readonly traceCapacity?: number;
}

/** Receives the effects of each reduction, in order. Injected, so tests fake it. */
export type EffectSink = (effects: readonly Effect[]) => void;

export interface KernelBus extends Bus {
  /** Routes a message to dispatch or absorb by its type literal. */
  route(msg: Message): void;
  getState(): KernelState;
  trace(): readonly TraceEntry[];
  setEffectSink(sink: EffectSink): void;
  /**
   * Swaps the reducer. Attach composes stage slices into a fresh reducer;
   * the swap happens between messages, never inside a flush.
   */
  setReducer(reducer: Reducer): void;

  on(event: string, fn: Listener): Unsubscribe;
  emitEvent(event: string, payload: unknown): void;

  registerCapability(capability: Capability): void;
  capabilities(): readonly Capability[];

  registerSink(contentType: ContentType, factory: SinkFactory): void;
  unregisterSink(contentType: ContentType): void;
  sinkFor(contentType: ContentType): SinkFactory | undefined;
  registerParser(mimeType: string, parse: ParserFn): void;
  unregisterParser(mimeType: string): void;
  parserFor(mimeType: string): ParserFn | undefined;
  registerTransform(step: TransformStep): void;
  unregisterTransform(step: TransformStep): void;
  transforms(): readonly TransformStep[];
  registerNamespace(name: string, api: object): void;
  unregisterNamespace(name: string): void;
  namespaces(): ReadonlyMap<string, object>;
}

export function createBus(options: CreateBusOptions): KernelBus {
  let reducer = options.reducer;
  const now = options.now ?? (() => globalThis.performance.now());
  const traceBuffer = createTraceBuffer(options.traceCapacity ?? DEFAULT_TRACE_CAPACITY);

  let state = options.initial;
  let effectSink: EffectSink = () => undefined;

  const queue: Message[] = [];
  let processing = false;

  const listeners = new Map<string, Set<Listener>>();
  const capabilities: Capability[] = [];
  const sinks = new Map<ContentType, SinkFactory>();
  const parsers = new Map<string, ParserFn>();
  const transformSteps: TransformStep[] = [];
  const namespaceMap = new Map<string, object>();

  function flush(): void {
    if (processing) return;
    processing = true;
    try {
      let msg = queue.shift();
      while (msg !== undefined) {
        const [next, effects] = reducer(state, msg);
        state = next;
        traceBuffer.push({ t: now(), msg, effects, digest: digest(state) });
        // The sink may re-enter dispatch or absorb; those enqueue and are
        // handled by this same loop, in order.
        effectSink(effects);
        msg = queue.shift();
      }
    } finally {
      processing = false;
    }
  }

  function enqueue(msg: Message): void {
    queue.push(msg);
    flush();
  }

  function emitEvent(event: string, payload: unknown): void {
    const set = listeners.get(event);
    if (set === undefined) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        // A throwing listener must not break the loop or its siblings.
        // Contained here; the listener's stage owns its own errors.
      }
    }
  }

  return {
    dispatch(cmd: Command): void {
      enqueue(cmd);
    },
    absorb(fact: Fact): void {
      enqueue(fact);
    },
    route(msg: Message): void {
      // Commands and facts share the queue; the reducer discriminates by
      // type literal. This exists for callers holding a Message, such as
      // the schedule effect handler delivering its `then` payload.
      enqueue(msg);
    },
    getState() {
      return state;
    },
    trace() {
      return traceBuffer.snapshot();
    },
    setEffectSink(sink) {
      effectSink = sink;
    },
    setReducer(next) {
      reducer = next;
    },

    on(event, fn) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    emitEvent,

    registerCapability(capability) {
      capabilities.push(capability);
    },
    capabilities() {
      return [...capabilities];
    },

    registerSink(contentType, factory) {
      if (sinks.has(contentType)) {
        throw new Error(`duplicate sink for '${contentType}'`);
      }
      sinks.set(contentType, factory);
    },
    unregisterSink(contentType) {
      sinks.delete(contentType);
    },
    sinkFor(contentType) {
      return sinks.get(contentType);
    },
    registerParser(mimeType, parse) {
      if (parsers.has(mimeType)) {
        throw new Error(`duplicate parser for '${mimeType}'`);
      }
      parsers.set(mimeType, parse);
    },
    unregisterParser(mimeType) {
      parsers.delete(mimeType);
    },
    parserFor(mimeType) {
      return parsers.get(mimeType);
    },
    registerTransform(step) {
      transformSteps.push(step);
      transformSteps.sort((a, b) => a.order - b.order);
    },
    unregisterTransform(step) {
      const index = transformSteps.indexOf(step);
      if (index >= 0) transformSteps.splice(index, 1);
    },
    transforms() {
      return [...transformSteps];
    },
    registerNamespace(name, api) {
      if (namespaceMap.has(name)) {
        throw new Error(`duplicate namespace '${name}'`);
      }
      namespaceMap.set(name, api);
    },
    unregisterNamespace(name) {
      namespaceMap.delete(name);
    },
    namespaces() {
      return namespaceMap;
    },
  };
}
