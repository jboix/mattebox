/**
 * The facade: flat and namespaced. Stages extend it by registering
 * namespaces, never by assigning onto it. The engine never shadows a
 * standard HTMLMediaElement member; `media` hands back the element itself.
 */
import type { ContentType, Track, TrackId } from './ir.js';
import type { KernelConfig, KernelState, TracedError, TraceEntry } from './kernel.js';
import type { Command } from './messages.js';
import type { QualityApi } from './quality.js';
import type { Listener, Stage, TransportRequestDraftView, Unsubscribe } from './stage.js';

/**
 * Generic track enumeration and selection. Chromium never shipped
 * AudioTrackList, so the engine owns the list and mirrors into native
 * where present.
 */
export interface TracksApi {
  readonly available: readonly Track[];
  active(contentType: ContentType): Track | null;
  select(trackId: TrackId): void;
  /** Stops a cue pipeline and clears its cues. Valid for text and metadata; video and audio always keep a selection. */
  deselect(contentType: ContentType): void;
}

export interface StatsApi {
  /** Exponentially weighted moving average of measured throughput, in bits per second. */
  readonly throughput: number;
  /** The diagnostic ring buffer, oldest first. Include it in every error report. */
  trace(): readonly TraceEntry[];
  /** The current kernel state, read-only. Diagnosability surface: the playground's panels draw from it. */
  snapshot(): Readonly<KernelState>;
}

/** The mutable request draft transport hooks receive. Structural twin of the transport module's type. */
export type { TransportRequestDraftView } from './stage.js';

export interface TransportResponseView {
  readonly token: string;
  readonly url: string;
  readonly status: number | null;
  readonly rtt: number;
  readonly size: number;
  readonly outcome: 'success' | 'failure' | 'timeout';
  readonly attempt: number;
}

/** Network-layer configuration: hooks and overrides the transport applies. */
export interface TransportConfig {
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly factor?: number;
    readonly maxDelayMs?: number;
    readonly retryStatuses?: readonly number[];
  };
  /** Replaces the network entirely: the fault-injection point. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly requestHooks?: ReadonlyArray<(req: TransportRequestDraftView) => void>;
  readonly responseHooks?: ReadonlyArray<(res: TransportResponseView) => void>;
}

export interface LoadOptions {
  /**
   * The manifest's MIME type, when the caller knows it. Authoritative: a
   * type no composed adapter accepts fails the load before any fetch with
   * MANIFEST_UNSUPPORTED, and an accepted type routes the bytes to that
   * adapter without sniffing. Omitted, the adapters sniff the bytes.
   */
  readonly mimeType?: string;
}

export interface MatteboxOptions {
  /** Stage factories to install, in order. Omitted means kernel only, which is a complete working player. */
  readonly stages?: readonly Stage[];
  /** Kernel tuning overrides. Every knob has a default. */
  readonly config?: Partial<KernelConfig>;
  /** Network hooks and overrides: cmcd, content steering, fault injection. */
  readonly transport?: TransportConfig;
}

/**
 * The kernel-owned facade surface. Namespaces contributed by stages
 * ('live', 'drm', 'thumbnails', ...) are absent unless the stage is loaded;
 * `'live' in engine` is the feature test. See `Mattebox` in the package
 * entry, which layers the merged namespaces on top of this.
 */
export interface MatteboxBase {
  /** The attached element, unwrapped, or null before attach. */
  readonly media: HTMLMediaElement | null;
  readonly quality: QualityApi;
  readonly tracks: TracksApi;
  readonly stats: StatsApi;
  /** The last fatal error, with the trace attached, or null. */
  readonly error: TracedError | null;
  attach(el: HTMLMediaElement): Promise<void>;
  /** Idempotent and safe to call from an error state. */
  detach(): Promise<void>;
  load(url: string, options?: LoadOptions): void;
  unload(): void;
  dispatch(cmd: Command): void;
  /** Every capability the loaded stages provide. */
  capabilities(): Iterable<string>;
  /**
   * Whether a composed adapter parses manifests of this MIME type. Case and
   * parameters are ignored. Pair it with the element's own `canPlayType`
   * to route a source between the engine and native playback; the engine
   * never sets `src` itself.
   */
  accepts(mimeType: string): boolean;
  on(event: string, fn: Listener): Unsubscribe;
}
