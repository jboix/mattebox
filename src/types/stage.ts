/**
 * The stage contract: the public plugin API. Four hook types express every
 * stage in the catalogue: sinks, parsers, transforms, and namespaces.
 *
 * Stages are inert. A stage module exports a factory; nothing registers at
 * import time. Any top-level side effect makes `sideEffects: false` a lie.
 */
import type { ContentType } from './ir.js';
import type { KernelState, SliceReducer } from './kernel.js';
import type { Command, CueDescriptor } from './messages.js';
import type { AbrChooser, SwitchPolicy } from './quality.js';
import type { SegmentMeta, Sink } from './sink.js';

/** Returned by `install` to undo everything the stage did. Called in reverse install order on detach. */
export type Teardown = () => void;

/** Reads a full SourceBuffer type, `video/mp4; codecs="..."`, from init segment bytes; null when it cannot. */
export type TypeProbe = (bytes: Uint8Array) => string | null;

/** The mutable outgoing-request view request hooks receive; url, headers, and timeout are writable. */
export interface TransportRequestDraftView {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number | null;
  readonly token: string;
  readonly attempt: number;
}

export type Unsubscribe = () => void;

export type Listener = (payload: unknown) => void;

/** A `{ contentType, mimeType }` pair a stage can handle. */
export interface CapabilityDescriptor {
  readonly contentType: ContentType;
  readonly mimeType: string;
}

/**
 * What a stage offers: a named capability such as 'live', a manifest MIME
 * type such as 'application/dash+xml' (any string containing '/'), or a
 * content handler pair. A manifest type makes `engine.accepts` answer true
 * and lets a `load` with that `mimeType` reach the stage's parser.
 */
export type Capability = string | CapabilityDescriptor;

/** What a registered sink factory receives when the kernel instantiates it. */
export interface SinkInit {
  readonly element: HTMLMediaElement;
}

export type SinkFactory<C extends ContentType = ContentType> = (init: SinkInit) => Sink<C>;

/** Parses one segment's bytes into cues. Registered per mimeType. */
export type ParserFn = (data: Uint8Array, meta: SegmentMeta) => readonly CueDescriptor[];

/**
 * One step of the segment byte pipeline. Transforms form an explicitly
 * ordered pipeline, not opportunistic listeners: decrypt then demux then
 * caption-extract has real ordering constraints. Lower `order` runs first.
 */
export interface TransformStep {
  readonly name: string;
  readonly order: number;
  transform(data: Uint8Array, meta: SegmentMeta): Uint8Array | Promise<Uint8Array>;
}

/**
 * What a stage receives at install time. Everything a stage does to the
 * engine goes through this context; stages never import each other.
 */
export interface StageContext {
  /** The attached media element. */
  readonly element: HTMLMediaElement;
  /**
   * Registers the destination for a content type. The factory's sink must
   * declare the same content type, which is what makes registration
   * type-safe per content type. NoInfer pins the type parameter to the
   * `contentType` argument, so a mismatched factory fails instead of
   * widening the inference to a union.
   */
  registerSink<C extends ContentType>(contentType: C, factory: SinkFactory<NoInfer<C>>): void;
  registerParser(mimeType: string, parse: ParserFn): void;
  registerTransform(step: TransformStep): void;
  /**
   * Exposes a public API surface as `engine.<name>`. Typing on the facade
   * comes from merging the `MatteboxNamespaces` interface declared in the
   * package entry; this call itself is untyped because the stage layer sits
   * below the facade in the module graph.
   */
  registerNamespace(name: string, api: object): void;
  /** A read-only snapshot of kernel state, for namespace getters. Reducers receive state as an argument; this is for the impure side. */
  getState(): Readonly<KernelState>;
  /**
   * Observes and may rewrite outgoing requests (the draft's url, headers,
   * and timeout are mutable). Steering and cmcd live here. Unregistered
   * with the stage.
   */
  addRequestHook(hook: (req: TransportRequestDraftView) => void): Unsubscribe;
  /**
   * A one-off network request through the transport's request hooks and
   * fetchImpl, for license and steering fetches. Awaits the Response.
   */
  request(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: ArrayBuffer | Uint8Array | string;
    },
  ): Promise<Response>;
  /**
   * Registers the abr opinion consulted at arbitration step 5. One chooser
   * per composition; a second registration is a composition error. The
   * chooser must be a pure function of its arguments or replay breaks.
   */
  registerChooser(chooser: AbrChooser): void;
  /**
   * Registers the switch policy consulted before a rendition change (the
   * entanglement #2 query). One per composition; codec-switch provides it.
   */
  registerSwitchPolicy(policy: SwitchPolicy): void;
  /**
   * Registers the reader of SourceBuffer types from init bytes, consulted
   * when a rendition declares no codecs (a bare media playlist): buffer
   * creation waits for the first segment and takes its type from what the
   * probe reads. One per composition; codec-probe provides it.
   */
  registerTypeProbe(probe: TypeProbe): void;
  /** Contributes a named state slice. The reducer receives only that slice plus a read-only kernel view. */
  reduce<S>(slice: string, reducer: SliceReducer<S>): void;
  dispatch(cmd: Command): void;
  /** Broadcasts an engine event, symmetric to `on`. The impure edge of a stage (eme-core) reports through it. */
  emit(event: string, payload: unknown): void;
  on(event: string, fn: Listener): Unsubscribe;
}

/**
 * One entry in a stage's `requires`. A plain string is a hard dependency. An
 * array is a set of alternatives: the composition satisfies it if any one of
 * them is present. text-cea608 requires its SEI source as
 * `['ts-transmux', 'nal-scan']`, either of which supplies the caption bytes.
 */
export type Requirement = string | readonly string[];

/**
 * A stage. `requires` names other stages or layer-2 modules resolved by the
 * loader; cross-stage needs are expressed here, never as imports.
 */
export interface Stage {
  readonly name: string;
  readonly provides?: readonly Capability[];
  readonly requires?: readonly Requirement[];
  // biome-ignore lint/suspicious/noConfusingVoidType: void is the intended "no teardown" return
  install(ctx: StageContext): void | Teardown;
}
