/**
 * The constraint solver: docs/08 made real. Selection mechanism lives in
 * the kernel; ABR is one optional voice with an opinion. With no abr
 * registered this module alone is a complete working player: lowest
 * permitted rendition at startup, then never change.
 *
 * Everything is a constraint. The effective allowed set is the
 * intersection of every named source; a pin is a preference resolved
 * after the intersection. Arbitration never yields zero playable
 * renditions.
 */
import type {
  ContentType,
  Coupling,
  Period,
  Rendition,
  RenditionId,
  TimeRangesSnapshot,
  TrackId,
} from '../types/ir.js';
import type { InflightRequest, SbId } from '../types/kernel.js';
import type { Effect } from '../types/messages.js';
import type {
  AbrChooser,
  AbrTelemetry,
  ApplyStrategy,
  ArbitrationResult,
  Constraint,
  SwitchVerdict,
} from '../types/quality.js';
import { bufferedEndFrom } from './scheduler.js';
import { segmentAtTime } from './timeline.js';

/** The lead time before which a `soon` switch never disturbs the buffer. */
const SOON_LEAD_SECONDS = 1.5;

const GAP_TOLERANCE = 0.25;

function matches(rendition: Rendition, constraint: Constraint): boolean {
  if (constraint.maxHeight !== undefined && (rendition.height ?? 0) > constraint.maxHeight) {
    return false;
  }
  if (constraint.maxWidth !== undefined && (rendition.width ?? 0) > constraint.maxWidth) {
    return false;
  }
  if (constraint.maxBitrate !== undefined && rendition.bitrate > constraint.maxBitrate) {
    return false;
  }
  if (constraint.minBitrate !== undefined && rendition.bitrate < constraint.minBitrate) {
    return false;
  }
  if (
    constraint.maxFrameRate !== undefined &&
    (rendition.frameRate ?? 0) > constraint.maxFrameRate
  ) {
    return false;
  }
  if (constraint.excludeIds?.includes(rendition.id)) {
    return false;
  }
  if (constraint.codecs !== undefined) {
    const codec = rendition.codecs;
    if (codec === null || !constraint.codecs.some((allowed) => codec.startsWith(allowed))) {
      return false;
    }
  }
  // constraint.hdr is accepted but not evaluated: the IR carries no HDR
  // signal yet. Registered in the debt register.
  if (constraint.filter !== undefined && !constraint.filter(rendition)) return false;
  return true;
}

function intersect(
  renditions: readonly Rendition[],
  constraints: ReadonlyArray<readonly [string, Constraint]>,
): Rendition[] {
  return renditions.filter((rendition) => constraints.every(([, c]) => matches(rendition, c)));
}

export type { AbrChooser, AbrTelemetry, SwitchPolicy, SwitchVerdict } from '../types/quality.js';

export interface ArbitrationContext {
  readonly renditions: readonly Rendition[];
  /** Insertion order is registration order; step 2 depends on it. */
  readonly constraints: ReadonlyMap<string, Constraint>;
  readonly pinned: RenditionId | null;
  readonly current: RenditionId | null;
  readonly couplings: readonly Coupling[];
  readonly activeTracks: ReadonlyMap<ContentType, TrackId>;
  /**
   * Companion groups present in the manifest, `contentType:groupId`. A
   * rendition whose coupling names an available group is allowed even when
   * the currently active companion is in a different group, because a
   * companion-switching stage (alt-audio) can move it. The filter only
   * vetoes when no switchable companion exists at all.
   */
  readonly availableGroups?: ReadonlySet<string>;
  readonly abr?: AbrChooser | null;
  readonly telemetry: AbrTelemetry;
}

export interface ArbitrationOutcome {
  readonly result: ArbitrationResult;
  /** Warning events the caller emits: unsatisfiable constraints, clamped pins, misbehaving abr. */
  readonly events: readonly Effect[];
}

function closestByBitrate(allowed: readonly Rendition[], target: Rendition): Rendition {
  let best = allowed[0] as Rendition;
  for (const candidate of allowed) {
    if (Math.abs(candidate.bitrate - target.bitrate) < Math.abs(best.bitrate - target.bitrate)) {
      best = candidate;
    }
  }
  return best;
}

function lowest(allowed: readonly Rendition[]): Rendition {
  let best = allowed[0] as Rendition;
  for (const candidate of allowed) {
    if (candidate.bitrate < best.bitrate) best = candidate;
  }
  return best;
}

/** The strict arbitration order from docs/08. Never deviate; never return zero renditions. */
export function arbitrate(ctx: ArbitrationContext): ArbitrationOutcome {
  const events: Effect[] = [];
  if (ctx.renditions.length === 0) {
    return {
      result: { allowed: [], droppedConstraints: [], selected: null, reason: 'lowest-permitted' },
      events,
    };
  }

  // 1. Intersect all constraints.
  const ordered = [...ctx.constraints.entries()];
  let active = ordered;
  let allowed = intersect(ctx.renditions, active);

  // 2. Drop in reverse registration order until non-empty. Not optional:
  // constraints must never produce an unplayable state.
  const dropped: string[] = [];
  while (allowed.length === 0 && active.length > 0) {
    const droppedEntry = active[active.length - 1] as readonly [string, Constraint];
    dropped.push(droppedEntry[0]);
    active = active.slice(0, -1);
    allowed = intersect(ctx.renditions, active);
  }
  if (dropped.length > 0) {
    events.push({
      kind: 'emit',
      event: 'quality:constraints-unsatisfiable',
      payload: { dropped },
    });
  }

  // 3. Filter by the coupling table against the active companion tracks.
  // A candidate that would orphan the active audio or text track is out.
  const coupled = allowed.filter((rendition) => {
    const coupling = ctx.couplings.find((c) => c.renditionId === rendition.id);
    if (coupling === undefined) return true;
    for (const [contentType, requiredTrack] of Object.entries(coupling.requires)) {
      const activeTrack = ctx.activeTracks.get(contentType as ContentType);
      // Couplings name the companion group; hoisted track ids read
      // `group:name`. The active companion already matches when its id is
      // the group or is prefixed by it.
      const matchesActive =
        activeTrack === requiredTrack || activeTrack?.startsWith(`${requiredTrack}:`) === true;
      if (activeTrack === undefined || matchesActive) continue;
      // The active companion is in another group. Allow the rendition
      // anyway when the required group exists to switch to; only veto when
      // no companion in that group is available at all.
      const switchable =
        ctx.availableGroups?.has(`${contentType}:${requiredTrack}`) === true ||
        ctx.availableGroups?.has(requiredTrack) === true;
      if (!switchable) return false;
    }
    return true;
  });
  if (coupled.length > 0) {
    allowed = coupled;
  } else {
    // The coupling filter may not empty the set either; keep the
    // constraint-allowed set and let the track layer resolve companions.
    events.push({
      kind: 'emit',
      event: 'quality:coupling-unsatisfiable',
      payload: { active: Object.fromEntries(ctx.activeTracks) as Record<string, string> },
    });
  }

  const allowedIds = allowed.map((r) => r.id);

  // 4. A pin that survives is used; a pin excluded by constraints clamps
  // to the nearest allowed rendition, with a warning, never a black screen.
  if (ctx.pinned !== null) {
    if (allowedIds.includes(ctx.pinned)) {
      return {
        result: {
          allowed: allowedIds,
          droppedConstraints: dropped,
          selected: ctx.pinned,
          reason: 'pin',
        },
        events,
      };
    }
    const target = ctx.renditions.find((r) => r.id === ctx.pinned);
    if (target !== undefined) {
      const clamped = closestByBitrate(allowed, target);
      events.push({
        kind: 'emit',
        event: 'quality:pin-unsatisfiable',
        payload: { pinned: ctx.pinned, resolved: clamped.id },
      });
      return {
        result: {
          allowed: allowedIds,
          droppedConstraints: dropped,
          selected: clamped.id,
          reason: 'pin',
        },
        events,
      };
    }
  }

  // 5. ABR is consulted, from within the allowed set only.
  if (ctx.abr != null) {
    const choice = ctx.abr.choose(allowed, ctx.telemetry);
    if (allowedIds.includes(choice)) {
      return {
        result: {
          allowed: allowedIds,
          droppedConstraints: dropped,
          selected: choice,
          reason: 'abr',
        },
        events,
      };
    }
    events.push({
      kind: 'emit',
      event: 'quality:abr-invalid',
      payload: { choice, allowed: allowedIds },
    });
  }

  // 6. Keep the current rendition when still permitted; else the lowest.
  if (ctx.current !== null && allowedIds.includes(ctx.current)) {
    return {
      result: {
        allowed: allowedIds,
        droppedConstraints: dropped,
        selected: ctx.current,
        reason: 'unchanged',
      },
      events,
    };
  }
  return {
    result: {
      allowed: allowedIds,
      droppedConstraints: dropped,
      selected: lowest(allowed).id,
      reason: 'lowest-permitted',
    },
    events,
  };
}

export interface Arbiter {
  /**
   * Arbitrates, memoized on the version key. TIME_UPDATE at 60 Hz must not
   * recompute the intersection; the key changes only when constraints,
   * tracks, the pin, the presentation, or (with abr loaded) a coarse
   * telemetry bucket change.
   */
  run(
    ctx: ArbitrationContext,
    version: number | string,
  ): ArbitrationOutcome & { computed: boolean };
  /** The rendition decoding at `currentTime`, from the append log. */
  playingAt(
    log: ReadonlyArray<readonly [{ readonly start: number; readonly end: number }, RenditionId]>,
    currentTime: number,
  ): RenditionId | null;
}

export function createArbiter(): Arbiter {
  let lastVersion: number | string = Number.NaN;
  let lastOutcome: ArbitrationOutcome | null = null;
  let lastPlaying: { rendition: RenditionId | null; start: number; end: number } | null = null;

  return {
    run(ctx, version) {
      if (lastOutcome !== null && version === lastVersion) {
        return { ...lastOutcome, computed: false };
      }
      lastOutcome = arbitrate(ctx);
      lastVersion = version;
      lastPlaying = null;
      return { ...lastOutcome, computed: true };
    },
    playingAt(log, currentTime) {
      if (
        lastPlaying !== null &&
        currentTime >= lastPlaying.start &&
        currentTime < lastPlaying.end
      ) {
        return lastPlaying.rendition;
      }
      let found: { rendition: RenditionId; start: number; end: number } | null = null;
      for (const [range, renditionId] of log) {
        if (range.start <= currentTime && currentTime < range.end) {
          found = { rendition: renditionId, start: range.start, end: range.end };
        }
      }
      lastPlaying = found ?? { rendition: null, start: currentTime, end: currentTime };
      return found?.rendition ?? null;
    },
  };
}

/** The four-character sample entry a codec string names, before any profile suffix. */
export function codecFamily(codecs: string | null): string | null {
  if (codecs === null) return null;
  const first = codecs.split(',')[0]?.trim() ?? '';
  const dot = first.indexOf('.');
  return dot === -1 ? first : first.slice(0, dot);
}

/**
 * The kernel's default answer to entanglement #2. codec-switch refines it
 * with real compatibility knowledge (Stage 15); until then: identical codec
 * strings are seamless, a profile or level change inside one family is a
 * changeType-class switch (every ladder rung carries its own profile
 * string, so abr could never move under an identity rule), and a family
 * change reloads.
 */
export function canSwitchTo(current: Rendition | null, target: Rendition): SwitchVerdict {
  if (current === null) return 'seamless';
  if (current.codecs !== null && current.codecs === target.codecs) return 'seamless';
  const family = codecFamily(current.codecs);
  if (family !== null && family === codecFamily(target.codecs)) return 'changeType';
  return 'reload';
}

export interface PinApplyInput {
  readonly strategy: ApplyStrategy;
  readonly currentTime: number;
  /** The target buffer's real ranges, from state. */
  readonly ranges: TimeRangesSnapshot;
  readonly sbId: SbId;
  readonly trackId: TrackId;
  /** Tokens of this track's in-flight requests, to abort. */
  readonly inflightTokens: readonly string[];
  readonly period: Period;
  readonly rendition: Rendition;
  readonly tokenSeq: number;
}

export interface PinApplyPlan {
  readonly effects: readonly Effect[];
  readonly requests: readonly InflightRequest[];
  readonly tokenSeq: number;
}

/**
 * The apply strategies from docs/08. `next` costs nothing and waits out
 * the buffer. `soon` flushes from the next segment boundary after
 * currentTime plus a lead, so the switch is usually invisible. `now` pays
 * a visible stall for immediacy.
 *
 * The plan never fetches. Flushing shrinks the buffered ranges, the
 * updateend fact drives the scheduling loop, and the loop refills from the
 * flush point with the init-before-media ordering a direct fetch here
 * would bypass. A pin to a rendition whose playlist is not merged yet
 * flushes the same way and refills once the playlist lands.
 */
export function planPinApply(input: PinApplyInput): PinApplyPlan {
  if (input.strategy === 'next') {
    return { effects: [], requests: [], tokenSeq: input.tokenSeq };
  }

  const effects: Effect[] = input.inflightTokens.map((token) => ({ kind: 'abort', token }));

  if (input.strategy === 'soon') {
    const bufferedEnd = bufferedEndFrom(input.ranges, input.currentTime, GAP_TOLERANCE);
    const lead = input.currentTime + SOON_LEAD_SECONDS;
    if (bufferedEnd > lead) {
      const boundarySegment = segmentAtTime(input.rendition.segments, lead, input.period.start);
      const safePoint =
        boundarySegment === null
          ? lead
          : boundarySegment.start > lead
            ? boundarySegment.start
            : boundarySegment.start + boundarySegment.duration;
      effects.push({ kind: 'remove', sbId: input.sbId, start: safePoint, end: Infinity });
    }
    // A buffer shorter than the lead has nothing safe to flush; the switch
    // degenerates to `next` semantics and continues at the buffered end.
    return { effects, requests: [], tokenSeq: input.tokenSeq };
  }

  // now: flush from the playhead and nudge the element so the decoder
  // picks up the replacement instead of holding stale frames.
  effects.push({ kind: 'remove', sbId: input.sbId, start: input.currentTime, end: Infinity });
  effects.push({ kind: 'seekElement', to: input.currentTime });
  return { effects, requests: [], tokenSeq: input.tokenSeq };
}
