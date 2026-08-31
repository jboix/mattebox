/**
 * Quality selection: constraints, not a level index. A pin is a constraint
 * whose allowed set has one member, so forcing a quality and disabling ABR
 * are the same operation.
 */
import type { Rendition, RenditionId } from './ir.js';

/**
 * A predicate over renditions. The effective allowed set is the intersection
 * of every registered constraint; releasing one source never disturbs the
 * others.
 */
export interface Constraint {
  readonly maxHeight?: number;
  readonly maxWidth?: number;
  readonly maxBitrate?: number;
  readonly minBitrate?: number;
  readonly maxFrameRate?: number;
  /** Codec allowlist, RFC 6381 strings. */
  readonly codecs?: readonly string[];
  /**
   * Renditions excluded by id. The serializable exclusion the recovery and
   * steering stages need; `filter` cannot travel in loop-back commands.
   */
  readonly excludeIds?: readonly RenditionId[];
  readonly hdr?: boolean;
  /** Escape hatch. A constraint carrying a filter is not serializable; prefer the declarative fields. */
  readonly filter?: (r: Rendition) => boolean;
}

/**
 * What the abr chooser sees. Every field derives from kernel state, so a
 * chooser that is a pure function of its arguments keeps replay exact.
 */
export interface AbrTelemetry {
  /** Slow throughput EWMA, bits per second. */
  readonly throughputEwma: number;
  /** Fast throughput EWMA; the minimum of the two is the conservative estimate. */
  readonly throughputFastEwma?: number;
  /** Seconds of continuous buffer ahead of the playhead for this track. */
  readonly bufferAhead?: number;
  /** The rendition currently being appended. */
  readonly current?: RenditionId | null;
  readonly currentTime: number;
  /** The switch policy in force: the kernel default, or codec-switch's refinement. */
  readonly canSwitchTo?: SwitchPolicy;
}

/** The optional voice. Registered by the abr stage; consulted, never trusted blindly. */
export interface AbrChooser {
  choose(allowed: readonly Rendition[], telemetry: AbrTelemetry): RenditionId;
}

/** Whether a switch from one rendition to another is free, needs a changeType, or forces a reload. */
export type SwitchVerdict = 'seamless' | 'changeType' | 'reload';

/**
 * The entanglement #2 query: codec-switch registers a real one, abr
 * consumes whatever is in force. A pure function of its two arguments.
 */
export type SwitchPolicy = (current: Rendition | null, target: Rendition) => SwitchVerdict;

/**
 * When a selection change takes effect.
 *
 * - 'next': at the next segment fetch. Free; latency equals buffer depth.
 * - 'soon': abort in-flight, remove from the next safe point, refetch. Usually invisible. The default.
 * - 'now': flush from currentTime and refetch. Visible stall of about one segment.
 */
export type ApplyStrategy = 'next' | 'soon' | 'now';

/** Why arbitration picked the selected rendition. */
export type ArbitrationReason = 'pin' | 'abr' | 'unchanged' | 'lowest-permitted';

/**
 * The outcome of one arbitration pass. Arbitration never resolves to zero
 * playable renditions: when the intersection is empty, constraints are
 * dropped in reverse registration order until it is not, and the dropped
 * sources are reported here.
 */
export interface ArbitrationResult {
  readonly allowed: readonly RenditionId[];
  readonly droppedConstraints: readonly string[];
  readonly selected: RenditionId | null;
  readonly reason: ArbitrationReason;
}

/**
 * The public quality surface. No sentinels; all plain getters.
 *
 * `active` and `playing` are distinct on purpose. After a 'next' switch the
 * engine appends the new rendition while the viewer still watches buffered
 * media from the old one. A quality menu must tick `playing`, not `active`.
 */
export interface QualityApi {
  /** Everything the manifest declared. */
  readonly renditions: readonly Rendition[];
  /** After constraint intersection. */
  readonly allowed: readonly Rendition[];
  /** The rendition currently being appended. */
  readonly active: Rendition | null;
  /** The rendition decoding at currentTime right now. */
  readonly playing: Rendition | null;
  readonly pinned: RenditionId | null;
  readonly constraints: ReadonlyMap<string, Constraint>;
  /** Registers or replaces the constraint for `source`. */
  constrain(source: string, constraint: Constraint): void;
  /** Removes the constraint for `source`. */
  release(source: string): void;
  /** Pins one rendition. Defaults to `{ apply: 'soon' }`. */
  pin(renditionId: RenditionId, options?: { readonly apply?: ApplyStrategy }): void;
  /** Clears the pin; ABR resumes if loaded. */
  auto(): void;
}
