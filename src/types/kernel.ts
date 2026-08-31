/**
 * Kernel state, the reducer contract, and the diagnostic trace. The state
 * shape is open to stage-contributed slices without `any`: named kernel
 * fields are typed, and everything else reads as `unknown`.
 */
import type { MatteboxError } from './error.js';
import type {
  ContentType,
  Presentation,
  RenditionId,
  TimeRange,
  TimeRangesSnapshot,
  TrackId,
} from './ir.js';
import type { Command, Effect, Fact, Message } from './messages.js';
import type { Constraint } from './quality.js';

export type { TimeRangesSnapshot };

/** Identifies one SourceBuffer for the lifetime of a MediaSource attachment. */
export type SbId = string;

/**
 * Tunable kernel behavior. Every knob has a default; the facade will expose
 * this through MatteboxOptions once the loader exists. Config is closure
 * configuration like slices: a replay must rebuild the reducer with the
 * same values.
 */
export interface KernelConfig {
  /** Smoothing factor for the slow throughput EWMA, in (0, 1]. */
  readonly ewmaAlpha: number;
  /** Smoothing factor for the fast throughput EWMA, in (0, 1]. Reacts to collapse; abr uses the minimum of the two. */
  readonly ewmaFastAlpha: number;
  /** Transfers smaller than this many bytes are jitter-dominated and never enter the EWMAs. */
  readonly ewmaMinSampleBytes: number;
  /**
   * Consecutive SourceBuffer failures on one buffer that halt its track
   * with a fatal error. The circuit breaker: without it a failing append
   * refetches the same segment forever.
   */
  readonly bufferErrorLimit: number;
  /**
   * Consecutive identical scheduler fetch decisions that halt playback
   * with a fatal error. The safety net behind bufferErrorLimit: it also
   * catches loops where every append reports success but buffered ranges
   * never advance.
   */
  readonly repeatFetchLimit: number;
  /** Seconds kept behind the playhead when quota pressure forces eviction. */
  readonly backBufferSeconds: number;
  /** Initial forward buffer goal in seconds, until SET_BUFFER_GOAL changes it. */
  readonly bufferGoalSeconds: number;
  /** Timeout for the manifest fetch effect, in milliseconds. */
  readonly manifestTimeoutMs: number;
  /** Capacity of the diagnostic ring buffer. */
  readonly traceCapacity: number;
  /** Backoff before a failed media fetch re-drives scheduling, in milliseconds. */
  readonly baseRetryDelayMs: number;
  /**
   * True when a loaded transform rewrites every segment's decode time to its
   * presentation start (ts-transmux, packed-audio, cmaf-timing). Media time
   * then equals presentation time by construction and the scheduler applies a
   * zero timestampOffset, instead of the epoch arithmetic that re-anchors the
   * media clock at a discontinuity and would shift such a segment twice.
   * The engine factory sets it from the composition's capabilities.
   */
  readonly mediaTimeNormalized: boolean;
}

export type LifecyclePhase = 'idle' | 'attaching' | 'loading' | 'ready' | 'ended' | 'error';

/** One request the transport currently has in flight, keyed by its effect token. */
export interface InflightRequest {
  readonly token: string;
  readonly trackId: TrackId;
  readonly seq: number;
  readonly url: string;
  /** The SourceBuffer the bytes are destined for, when known at request time. */
  readonly sbId?: SbId;
  /**
   * The timestampOffset this segment's append requires, computed by the
   * scheduler from the timeline epochs. The reducer emits a
   * setTimestampOffset effect before the append when it differs from the
   * offset currently applied to the buffer.
   */
  readonly timestampOffset?: number;
  /** The rendition the bytes belong to. Feeds the append log behind `quality.playing`. */
  readonly renditionId?: RenditionId;
  /** Segment window in presentation time, for the append log. */
  readonly segmentStart?: number;
  readonly segmentDuration?: number;
  /**
   * performance.now() at dispatch. Absent in state written by the reducer,
   * which has no clock; the effect runner records it.
   */
  readonly startedAt?: number;
}

export interface BufferState {
  readonly codecs: string;
  readonly ranges: TimeRangesSnapshot;
  readonly pendingAppends: number;
  /**
   * The rendition whose init segment this buffer last received. Media
   * segments are never scheduled ahead of their init: the scheduler
   * fetches the init first whenever this differs from the target.
   */
  readonly initFor?: RenditionId;
}

export interface QualityState {
  /**
   * Bumped by any constraint, pin, track, or presentation change. Derived
   * reads (allowed, playing) memoize on it so TIME_UPDATE at 60 Hz never
   * recomputes the constraint intersection.
   */
  readonly version: number;
  readonly constraints: ReadonlyMap<string, Constraint>;
  readonly pinned: RenditionId | null;
  /** The rendition currently being appended. */
  readonly active: RenditionId | null;
  /**
   * Which rendition occupies which buffered range. `quality.playing` is
   * derived by looking up currentTime here. Pruned behind the eviction point.
   */
  readonly appendLog: ReadonlyArray<readonly [TimeRange, RenditionId]>;
}

export interface StatsState {
  /** Slow exponentially weighted moving average of measured throughput, in bits per second. */
  readonly throughputEwma: number;
  /** Fast EWMA over the same samples; falls quickly when the network does. */
  readonly throughputFastEwma: number;
}

/**
 * The whole kernel state. Stages contribute additional slices under their
 * own names via `StageContext.reduce`; those read as `unknown` here and are
 * typed inside the owning stage.
 */
export interface KernelState {
  readonly [sliceName: string]: unknown;
  readonly lifecycle: { readonly phase: LifecyclePhase };
  readonly presentation: Presentation | null;
  readonly timeline: {
    readonly periodOffsets: ReadonlyMap<string, number>;
    readonly discontinuitySeq: number;
  };
  readonly buffers: ReadonlyMap<SbId, BufferState>;
  /** Consecutive SourceBuffer failures per buffer; a successful append clears the entry. */
  readonly bufferErrors: ReadonlyMap<SbId, number>;
  /**
   * Coverage per cue track (text, metadata), in presentation time. The cue
   * pipelines' analog of BufferState.ranges: merged from delivered segment
   * spans, because the reducer cannot query sink instances.
   */
  readonly cues: ReadonlyMap<TrackId, TimeRangesSnapshot>;
  /** The sliding availability window and the seek edge, from a live stage. Null until one reports. */
  readonly live: { readonly span: TimeRange; readonly edge: number } | null;
  readonly scheduling: {
    readonly inflight: ReadonlyMap<string, InflightRequest>;
    readonly bufferGoal: number;
    /**
     * Monotonic counter for effect tokens. Tokens come from state because
     * the reducer is pure: no Math.random(), no clocks.
     */
    readonly tokenSeq: number;
    /**
     * The last fetch decision and how many consecutive times it repeated
     * identically. The scheduling breaker: identical decisions past the
     * configured limit mean the loop makes no progress and must halt.
     */
    readonly repeat?: { readonly key: string; readonly count: number };
  };
  readonly tracks: {
    readonly active: ReadonlyMap<ContentType, TrackId>;
    readonly available: readonly TrackId[];
  };
  readonly quality: QualityState;
  readonly stats: StatsState;
  /** Last known playhead position, written from TIME_UPDATE, SEEKING, and SEEKED facts. */
  readonly playback: {
    readonly currentTime: number;
    readonly buffered: TimeRangesSnapshot;
    readonly seeking: boolean;
  };
}

/**
 * The pure kernel reducer. No await, no DOM, no fetch, no Date.now(), no
 * Math.random() inside it. Anything asynchronous is an effect.
 */
export type Reducer = (
  state: KernelState,
  msg: Message,
) => readonly [KernelState, readonly Effect[]];

/**
 * A stage-contributed reducer. It receives only its own slice, undefined on
 * first run, plus a read-only view of kernel state.
 */
export type SliceReducer<S = unknown> = (
  slice: S | undefined,
  msg: Message,
  kernel: Readonly<KernelState>,
) => readonly [S, readonly Effect[]];

/**
 * The two entry points, kept distinct in the type system: the reducer may
 * reject a command, it may never reject a fact. `absorb` must be callable
 * from arbitrary event handlers without ordering guarantees.
 */
export interface Bus {
  dispatch(cmd: Command): void;
  absorb(fact: Fact): void;
}

/** One entry of the diagnostic ring buffer. Fixed capacity, overwriting, default 500. */
export interface TraceEntry {
  /** performance.now() when the message entered the loop. */
  readonly t: number;
  readonly msg: Message;
  /** What the reducer emitted for this message. */
  readonly effects: readonly Effect[];
  /** Cheap hash of the relevant state slices, for divergence detection on replay. */
  readonly digest: string;
}

/**
 * A fatal error as surfaced on `engine.error`, with the ring buffer
 * attached. MatteboxError types `trace` loosely to stay a leaf module; this
 * is the precise shape.
 */
export type TracedError = MatteboxError & { readonly trace?: readonly TraceEntry[] };
