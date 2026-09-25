/**
 * The pure kernel reducer. reduce(state, msg) returns [nextState, effects]
 * and nothing else: no clocks, no randomness, no I/O. Time enters as fields
 * on facts; effect tokens come from a counter in state.
 *
 * A command may be rejected: unchanged state plus an emit effect describing
 * the rejection. A fact is never rejected: facts that make no sense in the
 * current state are absorbed and ignored, because the world already moved.
 */

import type { MatteboxError } from '../types/error.js';
import type { Presentation, Rendition, RenditionId, Track } from '../types/ir.js';
import type {
  AppendedSegment,
  BufferState,
  InflightRequest,
  KernelConfig,
  KernelState,
  Reducer,
  SbId,
  SliceReducer,
} from '../types/kernel.js';
import { APPENDED_MEMORY } from '../types/kernel.js';
import type { Command, Effect, Fact, Message, Serializable } from '../types/messages.js';
import type { MediaTimeProbe } from '../types/stage.js';
import { tickAfter } from './effects.js';
import { normalizeMimeType, typeString } from './mime.js';
import { findRendition, findTrackSite } from './presentation.js';
import { applyRefresh } from './refresh.js';
import type { AbrChooser, SwitchPolicy } from './rendition-select.js';
import {
  availableGroups,
  canSwitchTo,
  codecFamily,
  createArbiter,
  planPinApply,
  withDeadGroups,
} from './rendition-select.js';
import type { ScheduleTrackInput } from './scheduler.js';
import { bufferedEndFrom, schedule } from './scheduler.js';
import type { MediaContentType } from './sinks/mse-sink.js';
import { sbIdFor } from './sinks/mse-sink.js';
import { reconciledOffset, segmentAtTime } from './timeline.js';
import { DEFAULT_TRACE_CAPACITY } from './trace.js';

/**
 * The default tuning. Every value is overridable through the `config`
 * parameters of `initialState` and `createReducer`; these are starting
 * points, not policy.
 */
export const DEFAULT_KERNEL_CONFIG: KernelConfig = {
  // Small enough to ride out one odd sample.
  ewmaAlpha: 0.2,
  // Large enough that a collapse shows within two or three samples.
  ewmaFastAlpha: 0.6,
  // An init segment or playlist measures connection jitter, not bandwidth.
  ewmaMinSampleBytes: 10_000,
  // Three strikes: enough to ride out one transient, few enough that a
  // structurally unplayable track halts before the loop burns the network.
  bufferErrorLimit: 3,
  // Looser than the error breaker: flushes and seeks legitimately repeat a
  // decision once or twice; six identical ones in a row never happen.
  repeatFetchLimit: 5,
  backBufferSeconds: 30,
  bufferGoalSeconds: 30,
  manifestTimeoutMs: 10_000,
  traceCapacity: DEFAULT_TRACE_CAPACITY,
  // Long enough that a recovery stage's zero-delay commands apply first,
  // short enough that a retry without recovery still feels prompt.
  baseRetryDelayMs: 400,
};

export function resolveConfig(config?: Partial<KernelConfig>): KernelConfig {
  return { ...DEFAULT_KERNEL_CONFIG, ...config };
}

export function initialState(config?: Partial<KernelConfig>): KernelState {
  const cfg = resolveConfig(config);
  return {
    lifecycle: { phase: 'idle' },
    presentation: null,
    timeline: { periodOffsets: new Map(), discontinuitySeq: 0, reconciled: new Map() },
    buffers: new Map(),
    bufferErrors: new Map(),
    cues: new Map(),
    live: null,
    scheduling: { inflight: new Map(), bufferGoal: cfg.bufferGoalSeconds, tokenSeq: 0 },
    tracks: { active: new Map(), available: [] },
    quality: { version: 0, constraints: new Map(), pinned: null, active: null, appendLog: [] },
    stats: { throughputEwma: 0, throughputFastEwma: 0 },
    playback: { currentTime: 0, buffered: [], seeking: false },
  };
}

type Reduction = readonly [KernelState, readonly Effect[]];

/** Gap width treated as continuous when measuring buffered spans. */
const GAP_TOLERANCE = 0.25;

/** Drops one buffer's held init. */
function withoutPendingInit(
  pending: ReadonlyMap<SbId, RenditionId> | undefined,
  sbId: SbId,
): ReadonlyMap<SbId, RenditionId> | undefined {
  if (pending === undefined || !pending.has(sbId)) return pending;
  const next = new Map(pending);
  next.delete(sbId);
  return next.size === 0 ? undefined : next;
}

/** Writes held inits back into a scheduling slice; the field stays absent while empty. */
function withPendingInit(
  scheduling: KernelState['scheduling'],
  pending: ReadonlyMap<SbId, RenditionId> | undefined,
): KernelState['scheduling'] {
  if (pending !== undefined && pending.size > 0) return { ...scheduling, pendingInit: pending };
  const { pendingInit: _pendingInit, ...rest } = scheduling;
  return rest;
}

/** The codecs part of an MSE type string ('video/mp4; codecs="avc1.42c00d"' -> 'avc1.42c00d'). */
function bufferCodecString(type: string): string | null {
  const match = /codecs="?([^"]+)"?/.exec(type);
  return match?.[1] ?? null;
}

function reject(state: KernelState, command: Command['type'], reason: string): Reduction {
  return [state, [{ kind: 'emit', event: 'command:rejected', payload: { command, reason } }]];
}

/**
 * A manifest that will never yield a presentation. Every path lands here:
 * an adapter's parse failure (MANIFEST_FAILED), a fetch failure on the
 * manifest request, a `mimeType` no adapter accepts, and bytes no adapter
 * claims. One phase transition and one error shape, so an integrator
 * handles a single code per cause.
 */
function failManifest(
  state: KernelState,
  error: MatteboxError,
  extra: Readonly<Record<string, Serializable>> = {},
): Reduction {
  const phase = error.fatal ? 'error' : state.lifecycle.phase;
  return [
    { ...state, lifecycle: { phase } },
    [
      {
        kind: 'emit',
        event: 'error',
        payload: {
          category: error.category,
          code: error.code,
          fatal: error.fatal,
          recoverable: error.recoverable,
          ...extra,
        },
      },
    ],
  ];
}

/** The in-flight manifest request a SEGMENT_LOADED fact answers, or null. At most one is ever in flight. */
function manifestRequestFor(
  state: KernelState,
  msg: Extract<Fact, { type: 'SEGMENT_LOADED' }>,
): InflightRequest | null {
  if (msg.trackId !== 'manifest') return null;
  for (const request of state.scheduling.inflight.values()) {
    if (
      request.trackId === 'manifest' &&
      (msg.token === undefined || msg.token === request.token)
    ) {
      return request;
    }
  }
  return null;
}

function bumped(quality: KernelState['quality']): KernelState['quality'] {
  return { ...quality, version: quality.version + 1 };
}

/**
 * Forgets the last fetch decision. A pin or a seek legitimately makes the
 * scheduler repeat itself; only unprompted repetition means a stuck loop.
 */
function clearRepeat(scheduling: KernelState['scheduling']): KernelState['scheduling'] {
  if (scheduling.repeat === undefined) return scheduling;
  const { repeat: _repeat, ...rest } = scheduling;
  return rest;
}

function ewma(previous: number, sample: number, alpha: number): number {
  return previous === 0 ? sample : alpha * sample + (1 - alpha) * previous;
}

/** Merges one span into a sorted coverage list, coalescing overlaps. */
function mergeCoverage(
  coverage: readonly { readonly start: number; readonly end: number }[],
  added: { start: number; end: number },
): readonly { readonly start: number; readonly end: number }[] {
  const merged: Array<{ start: number; end: number }> = [];
  let pending = added;
  for (const range of coverage) {
    if (range.end < pending.start || range.start > pending.end) {
      merged.push(range);
    } else {
      pending = {
        start: Math.min(range.start, pending.start),
        end: Math.max(range.end, pending.end),
      };
    }
  }
  merged.push(pending);
  return merged.sort((a, b) => a.start - b.start);
}

/**
 * The spans `before` holds and `after` does not. Browsers round the ranges
 * they report, so a loss narrower than the gap tolerance is that rounding.
 */
function lostSpans(
  before: readonly { readonly start: number; readonly end: number }[],
  after: readonly { readonly start: number; readonly end: number }[],
): readonly { readonly start: number; readonly end: number }[] {
  const held = [...after].sort((a, b) => a.start - b.start);
  const lost: Array<{ start: number; end: number }> = [];
  for (const range of before) {
    let cursor = range.start;
    for (const kept of held) {
      if (kept.end <= cursor) continue;
      if (kept.start >= range.end) break;
      if (kept.start - cursor >= GAP_TOLERANCE) lost.push({ start: cursor, end: kept.start });
      cursor = kept.end;
    }
    if (range.end - cursor >= GAP_TOLERANCE) lost.push({ start: cursor, end: range.end });
  }
  return lost;
}

/** The buffers without what they remember receiving: one buffer, or all of them. */
function forgetAppended(
  buffers: ReadonlyMap<SbId, BufferState>,
  only?: SbId,
): ReadonlyMap<SbId, BufferState> {
  const next = new Map(buffers);
  for (const [sbId, buffer] of buffers) {
    if (buffer.appended === undefined || (only !== undefined && sbId !== only)) continue;
    const { appended: _appended, ...rest } = buffer;
    next.set(sbId, rest);
  }
  return next;
}

/**
 * The buffers after the flushes among `effects`. A flush is an unbounded
 * remove, and it forgets every segment that ends past its start: the next
 * append there starts a new run, so a segment that left nothing the first
 * time can land whole the second time. Lost content cannot say this, a
 * segment that left nothing has none to lose. A bounded remove is eviction
 * and reports through its updateend.
 */
function forgetFlushed(
  buffers: ReadonlyMap<SbId, BufferState>,
  effects: readonly Effect[],
): ReadonlyMap<SbId, BufferState> {
  let next = buffers;
  for (const effect of effects) {
    if (effect.kind !== 'remove' || effect.end !== Number.POSITIVE_INFINITY) continue;
    const buffer = next.get(effect.sbId);
    if (buffer?.appended === undefined) continue;
    const appended = buffer.appended.filter((seg) => seg.end <= effect.start);
    if (appended.length === buffer.appended.length) continue;
    next = new Map(next).set(effect.sbId, { ...buffer, appended });
  }
  return next;
}

function findTrack(presentation: Presentation | null, trackId: string): Track | null {
  return findTrackSite(presentation, trackId)?.track ?? null;
}

/**
 * The first candidate whose segment list places a boundary around `time`.
 * A flush is planned on segment boundaries, and a rendition selected for
 * the first time may have no segments yet, its media playlist still on its
 * way: planned on it, the flush would start at the playhead itself and
 * leave a segment head under the seek. The rendition playing always has
 * its segments.
 */
function segmentedAt(
  candidates: readonly (Rendition | undefined)[],
  time: number,
  periodStart: number,
): Rendition | undefined {
  return candidates.find(
    (rendition) =>
      rendition !== undefined && segmentAtTime(rendition.segments, time, periodStart) !== null,
  );
}

/**
 * Whether a completed request feeds the throughput estimate: only media of
 * the lead track (video where there is one, else audio). An audio segment
 * beside video, a text cue, or a playlist is a small transfer whose time
 * is latency, not bandwidth.
 */
function samplesThroughput(state: KernelState, request: InflightRequest): boolean {
  const lead = state.tracks.active.get('video') ?? state.tracks.active.get('audio');
  return lead === undefined ? request.renditionId === undefined : request.trackId === lead;
}

/** Abort effects for every matching in-flight request, plus the state with them removed. */
function abortInflight(
  state: KernelState,
  trackId?: string,
): readonly [KernelState, readonly Effect[]] {
  const effects: Effect[] = [];
  const inflight = new Map(state.scheduling.inflight);
  for (const [token, request] of state.scheduling.inflight) {
    if (trackId !== undefined && request.trackId !== trackId) continue;
    effects.push({ kind: 'abort', token });
    inflight.delete(token);
  }
  if (effects.length === 0) return [state, []];
  return [{ ...state, scheduling: { ...state.scheduling, inflight } }, effects];
}

function reduceCommand(
  state: KernelState,
  msg: Command,
  cfg: KernelConfig,
  hooks: ReducerHooks,
): Reduction {
  switch (msg.type) {
    case 'ATTACH': {
      if (state.lifecycle.phase !== 'idle') {
        return reject(state, msg.type, 'already attached');
      }
      return [{ ...state, lifecycle: { phase: 'attaching' } }, []];
    }

    case 'DETACH': {
      // Idempotent and safe from any phase, including error.
      const [, aborts] = abortInflight(state);
      return [initialState(cfg), aborts];
    }

    case 'LOAD': {
      if (state.lifecycle.phase === 'idle') {
        return reject(state, msg.type, 'not attached');
      }
      if (state.lifecycle.phase !== 'attaching') {
        return reject(state, msg.type, 'already loaded');
      }
      // An explicit mimeType is authoritative: when no composed adapter
      // declares it, the load fails here, before any bytes move. An
      // integrator's source resolver relies on this being cheap.
      if (msg.mimeType !== undefined && hooks.manifestTypes !== undefined) {
        const mimeType = normalizeMimeType(msg.mimeType);
        if (!hooks.manifestTypes.has(mimeType)) {
          return failManifest(
            state,
            { category: 'manifest', code: 'MANIFEST_UNSUPPORTED', fatal: true, recoverable: false },
            { mimeType },
          );
        }
      }
      const tokenSeq = state.scheduling.tokenSeq + 1;
      const token = `t${tokenSeq}:manifest`;
      const inflight = new Map(state.scheduling.inflight);
      inflight.set(token, { token, trackId: 'manifest', seq: 0, url: msg.url });
      return [
        {
          ...state,
          lifecycle: { phase: 'loading' },
          scheduling: { ...state.scheduling, inflight, tokenSeq },
        },
        [{ kind: 'fetch', token, url: msg.url, timeout: cfg.manifestTimeoutMs }],
      ];
    }

    case 'UNLOAD': {
      const [, aborts] = abortInflight(state);
      const fresh = initialState(cfg);
      const phase = state.lifecycle.phase === 'idle' ? 'idle' : 'attaching';
      // The source goes, so do its cues: a native track keeps rendering
      // what it holds, and the next source must not start under the last
      // subtitle of the previous one.
      const clears: Effect[] = [...state.cues.keys()].map((trackId) => ({
        kind: 'clearCues',
        trackId,
        start: 0,
        end: Number.POSITIVE_INFINITY,
      }));
      // The buffers and the media sink go with the source: the next load
      // starts on a fresh sink, as the reset state assumes. Without this
      // the controller keeps the old buffers and absorbs the next load's
      // create requests as duplicates, so the reducer never learns of them
      // and refetches the init segment without end.
      const reset: Effect[] = phase === 'attaching' ? [{ kind: 'resetSource' }] : [];
      return [
        {
          ...fresh,
          lifecycle: { phase },
          scheduling: { ...fresh.scheduling, tokenSeq: state.scheduling.tokenSeq },
        },
        [...aborts, ...clears, ...reset],
      ];
    }

    case 'SUSPEND': {
      if (state.lifecycle.phase !== 'ready') {
        return reject(state, msg.type, 'not ready');
      }
      const [next, aborts] = abortInflight(state);
      // The live span goes stale the moment reloads stop. Forgetting it
      // gates scheduling until a live slice reports a fresh one on resume,
      // and lets that report count as the first, so a live presentation
      // rejoins at the edge the way a fresh load does.
      return [{ ...next, lifecycle: { phase: 'suspended' }, live: null }, aborts];
    }

    case 'RESUME': {
      if (state.lifecycle.phase !== 'suspended') {
        return reject(state, msg.type, 'not suspended');
      }
      // VOD refills from the playhead at once. Live waits: scheduling
      // declines a live presentation without a span, and the live slice
      // reloads its playlists on this same command to bring one.
      return driveScheduling({ ...state, lifecycle: { phase: 'ready' } }, hooks, cfg);
    }

    case 'SEEK': {
      if (state.presentation === null) {
        return reject(state, msg.type, 'no source');
      }
      const [next, aborts] = abortInflight(state);
      // A live span bounds the seek: behind it nothing is available any
      // more, ahead of it nothing exists yet. The edge, not the span end,
      // is the far bound, so a seek to "now" lands where playback can start.
      const to =
        state.live === null
          ? msg.to
          : Math.min(Math.max(msg.to, state.live.span.start), state.live.edge);
      return [
        { ...next, scheduling: clearRepeat(next.scheduling) },
        [...aborts, { kind: 'seekElement', to }],
      ];
    }

    case 'SEEK_TO_LIVE_EDGE': {
      if (state.presentation === null || !state.presentation.isLive) {
        return reject(state, msg.type, 'not live');
      }
      if (state.live === null) {
        return reject(state, msg.type, 'no live support loaded');
      }
      const [next, aborts] = abortInflight(state);
      return [
        { ...next, scheduling: clearRepeat(next.scheduling) },
        [...aborts, { kind: 'seekElement', to: state.live.edge }],
      ];
    }

    case 'SELECT_TRACK': {
      const track = findTrack(state.presentation, msg.trackId);
      if (track === null) {
        return reject(state, msg.type, `unknown track: ${msg.trackId}`);
      }
      // A track the browser cannot decode would fail its buffer.
      const undecodableIds = state.quality.constraints.get(CODECS)?.excludeIds ?? [];
      if (
        track.renditions.length > 0 &&
        track.renditions.every((r) => undecodableIds.includes(r.id))
      ) {
        return reject(state, msg.type, `undecodable track: ${msg.trackId}`);
      }
      const previous = state.tracks.active.get(track.contentType);
      const active = new Map(state.tracks.active);
      active.set(track.contentType, track.id);
      const effects: Effect[] = [];
      let buffers = state.buffers;
      let inflight = state.scheduling.inflight;
      // A media track change mid-stream flushes the old track's buffer
      // ahead, the way a pin does: from the playhead's segment for a
      // viewer's choice, from a boundary ahead for a coupling that follows
      // a video switch, so the old track plays out and nothing runs dry
      // under the playhead. Clearing the whole buffer instead stalls
      // playback until the new track's first segment lands. The element is
      // not nudged for audio: a video decoder holds stale frames, an audio
      // one does not.
      const site = findTrackSite(state.presentation, track.id);
      const previousTrack = previous === undefined ? null : findTrack(state.presentation, previous);
      const flushRendition =
        site === null
          ? undefined
          : (segmentedAt(
              [...track.renditions, ...(previousTrack?.renditions ?? [])],
              state.playback.currentTime,
              site.period.start,
            ) ?? track.renditions[0]);
      if (
        previous !== undefined &&
        previous !== track.id &&
        (track.contentType === 'audio' || track.contentType === 'video') &&
        site !== null &&
        flushRendition !== undefined
      ) {
        const sbId = sbIdFor(track.contentType);
        const buffer = state.buffers.get(sbId);
        if (buffer !== undefined) {
          const plan = planPinApply({
            strategy: msg.apply ?? 'now',
            currentTime: state.playback.currentTime,
            ranges: buffer.ranges,
            sbId,
            trackId: track.id,
            inflightTokens: [],
            period: site.period,
            rendition: flushRendition,
            tokenSeq: state.scheduling.tokenSeq,
          });
          for (const effect of plan.effects) {
            if (effect.kind !== 'seekElement' || track.contentType === 'video') {
              effects.push(effect);
            }
          }
          // Force an init re-fetch for the new track: its initFor no
          // longer matches, so scheduling fetches init before media.
          const next = new Map(state.buffers);
          const { initFor: _initFor, ...rest } = buffer;
          next.set(sbId, rest);
          buffers = next;
          // Drop the old track's in-flight fetches.
          const pruned = new Map(state.scheduling.inflight);
          for (const [token, request] of state.scheduling.inflight) {
            if (request.trackId === previous) {
              effects.push({ kind: 'abort', token });
              pruned.delete(token);
            }
          }
          inflight = pruned;
        }
      }
      if (previous !== track.id) {
        effects.push({
          kind: 'emit',
          event: 'tracks:selected',
          payload: { contentType: track.contentType, trackId: track.id },
        });
      }
      return [
        {
          ...state,
          tracks: { ...state.tracks, active },
          buffers,
          scheduling: clearRepeat({ ...state.scheduling, inflight }),
          quality: bumped(state.quality),
        },
        effects,
      ];
    }

    case 'DESELECT_TRACK': {
      if (msg.contentType !== 'text' && msg.contentType !== 'metadata') {
        return reject(state, msg.type, 'video and audio always keep a selection');
      }
      const trackId = state.tracks.active.get(msg.contentType);
      if (trackId === undefined) return [state, []];
      const active = new Map(state.tracks.active);
      active.delete(msg.contentType);
      const cues = new Map(state.cues);
      cues.delete(trackId);
      const [aborted, abortEffects] = abortInflight(state, trackId);
      return [
        {
          ...aborted,
          tracks: { ...state.tracks, active },
          cues,
          quality: bumped(state.quality),
        },
        [
          ...abortEffects,
          { kind: 'clearCues', trackId, start: 0, end: Number.POSITIVE_INFINITY },
          {
            kind: 'emit',
            event: 'tracks:selected',
            payload: { contentType: msg.contentType, trackId: null },
          },
        ],
      ];
    }

    case 'PIN_RENDITION': {
      const site = findRendition(state.presentation, msg.renditionId);
      if (site === null) {
        return reject(state, msg.type, `unknown rendition: ${msg.renditionId}`);
      }
      const pinnedState: KernelState = {
        ...state,
        quality: bumped({ ...state.quality, pinned: site.rendition.id, active: site.rendition.id }),
      };
      // Apply planning needs a buffer to flush; text and metadata pins
      // change future fetches only.
      if (site.track.contentType !== 'video' && site.track.contentType !== 'audio') {
        return [pinnedState, []];
      }
      const sbId = sbIdFor(site.track.contentType as MediaContentType);
      const inflightTokens: string[] = [];
      for (const request of state.scheduling.inflight.values()) {
        if (request.trackId === site.track.id) inflightTokens.push(request.token);
      }
      const active =
        state.quality.active === null
          ? null
          : findRendition(state.presentation, state.quality.active);
      const plan = planPinApply({
        strategy: msg.apply,
        currentTime: state.playback.currentTime,
        ranges: state.buffers.get(sbId)?.ranges ?? [],
        sbId,
        trackId: site.track.id,
        inflightTokens,
        period: site.period,
        rendition:
          segmentedAt(
            [site.rendition, active?.rendition],
            state.playback.currentTime,
            site.period.start,
          ) ?? site.rendition,
        tokenSeq: state.scheduling.tokenSeq,
      });
      const inflight = new Map(state.scheduling.inflight);
      for (const token of inflightTokens) inflight.delete(token);
      for (const request of plan.requests) inflight.set(request.token, request);
      return [
        {
          ...pinnedState,
          scheduling: clearRepeat({ ...state.scheduling, inflight, tokenSeq: plan.tokenSeq }),
        },
        plan.effects,
      ];
    }

    case 'RELEASE_PIN': {
      return [{ ...state, quality: bumped({ ...state.quality, pinned: null }) }, []];
    }

    case 'CONSTRAIN': {
      const constraints = new Map(state.quality.constraints);
      constraints.set(msg.source, msg.constraint);
      // A changed allowed set means the last fetch decision is no longer
      // the same decision; reset the repeat breaker so recovery's exclusion
      // gets a chance to switch renditions before failures re-trip it.
      return [
        {
          ...state,
          quality: bumped({ ...state.quality, constraints }),
          scheduling: clearRepeat(state.scheduling),
        },
        [],
      ];
    }

    case 'RELEASE_CONSTRAINT': {
      if (!state.quality.constraints.has(msg.source)) return [state, []];
      const constraints = new Map(state.quality.constraints);
      constraints.delete(msg.source);
      return [
        {
          ...state,
          quality: bumped({ ...state.quality, constraints }),
          scheduling: clearRepeat(state.scheduling),
        },
        [],
      ];
    }

    case 'SET_BUFFER_GOAL': {
      if (!Number.isFinite(msg.seconds) || msg.seconds <= 0) {
        return reject(state, msg.type, 'invalid buffer goal');
      }
      return [{ ...state, scheduling: { ...state.scheduling, bufferGoal: msg.seconds } }, []];
    }

    case 'ABORT_INFLIGHT': {
      return abortInflight(state, msg.trackId);
    }
  }
}

/** The constraint source for renditions this browser cannot decode. */
const CODECS = 'codecs';

/**
 * The renditions this browser cannot play: a declared codec it does not
 * decode, and a video variant whose audio group it cannot decode at all.
 * VHS drops these when the manifest loads; left in, ABR climbs onto one and
 * its buffer fails to open or to append. A rendition that declares no
 * codec counts as decodable.
 */
function undecodable(
  presentation: Presentation,
  decodable: (type: string) => boolean,
): Set<string> {
  const out = new Set<string>();
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (track.contentType !== 'video' && track.contentType !== 'audio') continue;
      for (const r of track.renditions) {
        if (r.codecs !== null && !decodable(typeString(r.mimeType, r.codecs))) out.add(r.id);
      }
    }
  }
  return withDeadGroups(presentation, out);
}

/**
 * A presentation replaces the one held: a manifest landed, or a playlist
 * merged into it. Activates default tracks and reports what changed.
 */
function loadPresentation(
  state: KernelState,
  presentation: Presentation,
  undecodableIds: ReadonlySet<string> = new Set(),
): Reduction {
  const available: string[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) available.push(track.id);
  }
  const inflight = new Map(state.scheduling.inflight);
  for (const [token, request] of inflight) {
    if (request.trackId === 'manifest') inflight.delete(token);
  }
  const phase = state.lifecycle.phase === 'loading' ? 'ready' : state.lifecycle.phase;
  // Default activation: the first video and audio track the browser can
  // decode, so a manifest alone yields a playable composition without a
  // SELECT_TRACK.
  const active = new Map(state.tracks.active);
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (
        (track.contentType === 'video' || track.contentType === 'audio') &&
        !active.has(track.contentType) &&
        track.renditions.some((r) => !undecodableIds.has(r.id))
      ) {
        active.set(track.contentType, track.id);
      }
    }
  }
  const loaded: KernelState = {
    ...state,
    lifecycle: { phase },
    presentation,
    scheduling: { ...state.scheduling, inflight },
    tracks: { active, available },
    quality: bumped(state.quality),
  };
  // Every playlist merge lands here too; the track list only changed if
  // the ids did.
  const sameTracks =
    available.length === state.tracks.available.length &&
    available.every((id, index) => id === state.tracks.available[index]);
  const manifestEffects: Effect[] = sameTracks
    ? []
    : [{ kind: 'emit', event: 'tracks:changed', payload: { available } }];
  // The manifest DRM route: emit every track's protection schemes so
  // eme-core (if loaded) can open sessions. Serializable init data
  // rides the event; nothing DRM-specific enters the reducer.
  const schemes = presentation.periods.flatMap((period) =>
    period.tracks.flatMap((track) => track.protection?.schemes ?? []),
  );
  if (schemes.length > 0) {
    manifestEffects.push({
      kind: 'emit',
      event: 'presentation:protection',
      payload: schemes as unknown as import('../types/messages.js').Serializable,
    });
  }
  if (!presentation.isLive && presentation.duration !== undefined) {
    manifestEffects.push({ kind: 'setDuration', seconds: presentation.duration });
  }
  return [loaded, manifestEffects];
}

function reduceFact(
  state: KernelState,
  msg: Fact,
  cfg: KernelConfig,
  hooks: ReducerHooks,
): Reduction {
  switch (msg.type) {
    case 'ELEMENT_ATTACHED':
    case 'MEDIASOURCE_OPEN':
    case 'MEDIASOURCE_CLOSED':
      // Lifecycle detail owned by the mse module. Absorbed for the trace.
      return [state, []];

    case 'MANIFEST_LOADED': {
      if (hooks.decodable === undefined) return loadPresentation(state, msg.presentation);
      const excluded = undecodable(msg.presentation, hooks.decodable);
      const tracks = msg.presentation.periods.flatMap((period) => period.tracks);
      const lead = (['video', 'audio'] as const).find((c) =>
        tracks.some((t) => t.contentType === c),
      );
      // Nothing to play: say so now, not after a buffer fails to open.
      if (
        lead !== undefined &&
        !tracks.some((t) => t.contentType === lead && t.renditions.some((r) => !excluded.has(r.id)))
      ) {
        const codecs = new Set(tracks.flatMap((t) => t.renditions.map((r) => r.codecs ?? '')));
        codecs.delete('');
        return failManifest(
          state,
          { category: 'media', code: 'MEDIA_CODEC_UNSUPPORTED', fatal: true, recoverable: false },
          { codecs: [...codecs] },
        );
      }
      const constraints = new Map(state.quality.constraints);
      if (excluded.size > 0) constraints.set(CODECS, { excludeIds: [...excluded] });
      else constraints.delete(CODECS);
      return loadPresentation(
        { ...state, quality: { ...state.quality, constraints } },
        msg.presentation,
        excluded,
      );
    }

    case 'MANIFEST_FAILED':
      return failManifest(state, msg.error);

    case 'PLAYLIST_REFRESHED': {
      // Merged into the presentation held now, not a snapshot an adapter
      // took earlier: another rendition may have merged in between.
      const merged = state.presentation === null ? null : applyRefresh(state.presentation, msg);
      if (merged === null) return [state, []];
      return loadPresentation(state, merged);
    }

    case 'MEDIA_ERROR': {
      // The element gave up. An engine that already failed keeps its error.
      if (state.lifecycle.phase === 'error') return [state, []];
      const [stopped, aborts] = abortInflight(state);
      const [failed, report] = failManifest(
        stopped,
        { ...msg.error, fatal: true },
        // The facade builds this context from the element's strings.
        { context: msg.error.context as { readonly [key: string]: Serializable } },
      );
      return [failed, [...aborts, ...report]];
    }

    case 'SEGMENT_LOADED': {
      let matched: InflightRequest | null = null;
      if (msg.token !== undefined) {
        // The token names one request. Track and sequence alone would also
        // match the refetch that replaced an aborted request.
        matched = state.scheduling.inflight.get(msg.token) ?? null;
      } else {
        for (const request of state.scheduling.inflight.values()) {
          if (request.trackId === msg.trackId && request.seq === msg.seq) {
            matched = request;
            break;
          }
        }
      }
      if (matched === null) {
        // Late arrival for an aborted or superseded request. The bytes
        // already crossed the network; absorb and drop them.
        return [state, []];
      }
      const inflight = new Map(state.scheduling.inflight);
      inflight.delete(matched.token);
      // The throughput estimate follows the lead track: a 96 KB audio
      // segment beside a 2 MB video segment measures latency, not the link,
      // and would drag the estimate down to a fraction of what video sees.
      const sampleBps =
        msg.rtt > 0 && msg.size >= cfg.ewmaMinSampleBytes && samplesThroughput(state, matched)
          ? (msg.size * 8000) / msg.rtt
          : null;
      const stats =
        sampleBps === null
          ? state.stats
          : {
              throughputEwma: ewma(state.stats.throughputEwma, sampleBps, cfg.ewmaAlpha),
              throughputFastEwma: ewma(
                state.stats.throughputFastEwma,
                sampleBps,
                cfg.ewmaFastAlpha,
              ),
            };
      let buffers = state.buffers;
      let pendingInit = state.scheduling.pendingInit;
      let timeline = state.timeline;
      let quality = state.quality;
      let cues = state.cues;
      const effects: Effect[] = [];
      // No SourceBuffer destination: a cue track's segment routes to its
      // sink through the deliver effect. Coverage merges here, from the
      // request's own timing, so a parse failure still counts as covered
      // and the scheduler never refetch-loops a bad segment.
      const cueTrack =
        matched.sbId === undefined ? findTrack(state.presentation, matched.trackId) : null;
      if (
        cueTrack !== null &&
        (cueTrack.contentType === 'text' || cueTrack.contentType === 'metadata') &&
        matched.segmentStart !== undefined
      ) {
        const span = {
          start: matched.segmentStart,
          end: matched.segmentStart + (matched.segmentDuration ?? 0),
        };
        const next = new Map(cues);
        next.set(matched.trackId, mergeCoverage(cues.get(matched.trackId) ?? [], span));
        cues = next;
        effects.push({
          kind: 'deliver',
          trackId: matched.trackId,
          contentType: cueTrack.contentType,
          data: msg.bytes,
          meta: {
            trackId: matched.trackId,
            renditionId: matched.renditionId ?? '',
            contentType: cueTrack.contentType,
            seq: matched.seq,
            start: matched.segmentStart,
            duration: matched.segmentDuration ?? 0,
            isInit: matched.seq < 0,
          },
        });
      }
      if (matched.sbId !== undefined) {
        // seq below zero is the init-segment convention: mark the buffer
        // initialized for this rendition so media scheduling can proceed.
        if (matched.seq < 0 && matched.renditionId !== undefined) {
          const buffer = state.buffers.get(matched.sbId);
          if (buffer !== undefined) {
            // A switch that changes the codec family needs a changeType
            // before the new init, or the append fails. In-family profile
            // changes append the new init bare: browsers accept those in
            // practice, and forcing changeType there breaks WebKit. The
            // reducer emits the mechanism; codec-switch's policy governed
            // whether abr proposed the switch at all.
            // A rendition that declares no codecs (a bare media playlist)
            // cannot name a family change. The buffer keeps the type it was
            // opened with, which codec-probe may have read from the init;
            // a changeType back to the bare type fails in Chrome and WebKit.
            const targetSite = findRendition(state.presentation, matched.renditionId);
            const declared = targetSite?.rendition.codecs ?? null;
            const targetCodecs =
              targetSite === null || declared === null
                ? buffer.codecs
                : typeString(targetSite.rendition.mimeType, declared);
            const familyChanged =
              declared !== null &&
              codecFamily(declared) !== codecFamily(bufferCodecString(buffer.codecs));
            const nextBuffers = new Map(state.buffers);
            if (targetCodecs !== buffer.codecs && familyChanged) {
              effects.push({ kind: 'changeType', sbId: matched.sbId, codecs: targetCodecs });
            }
            nextBuffers.set(matched.sbId, {
              ...buffer,
              initFor: matched.renditionId,
              codecs: targetCodecs,
            });
            buffers = nextBuffers;
            pendingInit = withoutPendingInit(pendingInit, matched.sbId);
          } else {
            // The bytes beat the SOURCEBUFFER_CREATED fact: after a reload
            // the media source has to reopen before the buffer exists. The
            // controller holds the append until it does, so the init is
            // recorded here and adopted on creation instead of refetched.
            pendingInit = new Map(pendingInit ?? []).set(matched.sbId, matched.renditionId);
          }
        }
        // A media segment decodes only under its own rendition's init
        // segment. A constraint or pin can move the buffer to another
        // rendition while this request was in flight, and its bytes would
        // then meet the wrong parameter sets: a hardware decoder rejects
        // them as malformed. Drop them; scheduling below refetches the
        // span from the rendition the buffer is set up for.
        const initFor = buffers.get(matched.sbId)?.initFor;
        if (
          matched.seq >= 0 &&
          matched.renditionId !== undefined &&
          initFor !== undefined &&
          initFor !== matched.renditionId
        ) {
          const next: KernelState = {
            ...state,
            scheduling: withPendingInit({ ...state.scheduling, inflight }, pendingInit),
            stats,
            buffers,
            cues,
          };
          // SEGMENT_LOADED drives scheduling on the way out, so the span is
          // refetched from the rendition the buffer holds the init for.
          return [
            next,
            [
              ...effects,
              {
                kind: 'emit',
                event: 'quality:stale-segment',
                payload: { renditionId: matched.renditionId, seq: matched.seq, initFor },
              },
            ],
          ];
        }
        // The offset this append takes. The first media segment to land in
        // an epoch settles it for every buffer: its presentation start minus
        // the decode time the probe read from its bytes, or the manifest's
        // prediction when nothing read one. Later segments of the epoch,
        // on any buffer, apply the settled value, so audio and video keep
        // the alignment their shared media clock gives them: one offset per
        // timeline, as videojs-http-streaming takes it from its main loader.
        // Playlist discontinuities and period boundaries both land here.
        let reconciled = state.timeline.reconciled;
        let offset = matched.epoch === undefined ? undefined : reconciled.get(matched.epoch);
        if (
          offset === undefined &&
          matched.epoch !== undefined &&
          matched.seq >= 0 &&
          matched.segmentStart !== undefined
        ) {
          const settled =
            msg.mediaStart !== undefined
              ? reconciledOffset(matched.segmentStart, msg.mediaStart)
              : matched.timestampOffset;
          if (settled !== undefined) {
            offset = settled;
            reconciled = new Map(reconciled).set(matched.epoch, settled);
          }
        }
        if (offset === undefined) offset = matched.timestampOffset;
        let periodOffsets = state.timeline.periodOffsets;
        if (offset !== undefined && periodOffsets.get(matched.sbId) !== offset) {
          effects.push({ kind: 'setTimestampOffset', sbId: matched.sbId, offset });
          periodOffsets = new Map(periodOffsets).set(matched.sbId, offset);
        }
        if (
          periodOffsets !== state.timeline.periodOffsets ||
          reconciled !== state.timeline.reconciled
        ) {
          timeline = { ...state.timeline, periodOffsets, reconciled };
        }
        effects.push({ kind: 'append', sbId: matched.sbId, data: msg.bytes });
        const buffer = buffers.get(matched.sbId);
        if (buffer !== undefined) {
          const nextBuffers = new Map(buffers);
          // What the buffer receives, so the scheduler never asks for it
          // twice. Media only, and with the span it lands at, so a removal
          // there can forget it.
          let appended = buffer.appended;
          const { renditionId, seq, segmentStart } = matched;
          if (seq >= 0 && renditionId !== undefined && segmentStart !== undefined) {
            const entry: AppendedSegment = {
              renditionId,
              seq,
              start: segmentStart,
              end: segmentStart + (matched.segmentDuration ?? 0),
            };
            appended = [
              ...(appended ?? [])
                .filter((seg) => seg.seq !== seq || seg.renditionId !== renditionId)
                .slice(1 - APPENDED_MEMORY),
              entry,
            ];
          }
          nextBuffers.set(matched.sbId, {
            ...buffer,
            pendingAppends: buffer.pendingAppends + 1,
            ...(appended !== undefined ? { appended } : {}),
          });
          buffers = nextBuffers;
        }
        if (
          matched.sbId === sbIdFor('video') &&
          matched.renditionId !== undefined &&
          matched.segmentStart !== undefined
        ) {
          // The append log behind quality.playing: which video rendition
          // occupies which span of the buffer. Video only: an audio append
          // carries its track id here, and logging it would answer
          // `playing` with an id no video rendition has. Pruned behind the
          // eviction watermark, so its size is bounded by the buffered span
          // over the segment duration.
          const watermark = state.playback.currentTime - cfg.backBufferSeconds;
          const appendLog = [
            ...state.quality.appendLog.filter(([range]) => range.end > watermark),
            [
              {
                start: matched.segmentStart,
                end: matched.segmentStart + (matched.segmentDuration ?? 0),
              },
              matched.renditionId,
            ] as const,
          ];
          quality = { ...quality, appendLog };
        }
      }
      return [
        {
          ...state,
          buffers,
          timeline,
          quality,
          cues,
          scheduling: withPendingInit({ ...state.scheduling, inflight }, pendingInit),
          stats,
        },
        effects,
      ];
    }

    case 'SEGMENT_FAILED': {
      const inflight = new Map(state.scheduling.inflight);
      for (const [token, request] of inflight) {
        if (request.trackId === msg.trackId && request.seq === msg.seq) inflight.delete(token);
      }
      // The manifest request has no rendition to exclude and no segment to
      // skip: the transport already retried per policy, so its failure is
      // the load's failure. Without this the engine sat in `loading` with
      // a non-fatal error and a retry tick that had nothing to schedule.
      if (msg.trackId === 'manifest') {
        const contentType = msg.error.context?.contentType;
        return failManifest(
          { ...state, scheduling: { ...state.scheduling, inflight } },
          { ...msg.error, fatal: true, recoverable: false },
          {
            status: msg.status ?? null,
            ...(typeof contentType === 'string' ? { contentType } : {}),
          },
        );
      }
      // A cue pipeline degrades, never kills playback: subtitles stop,
      // video continues. The span counts as covered so the scheduler moves
      // on instead of hammering the same missing segment.
      const failedTrack = findTrack(state.presentation, msg.trackId);
      const isCueTrack =
        failedTrack !== null &&
        (failedTrack.contentType === 'text' || failedTrack.contentType === 'metadata');
      let cues = state.cues;
      if (isCueTrack) {
        const request = [...state.scheduling.inflight.values()].find(
          (r) => r.trackId === msg.trackId && r.seq === msg.seq,
        );
        if (request?.segmentStart !== undefined) {
          const next = new Map(cues);
          next.set(
            msg.trackId,
            mergeCoverage(cues.get(msg.trackId) ?? [], {
              start: request.segmentStart,
              end: request.segmentStart + (request.segmentDuration ?? 0),
            }),
          );
          cues = next;
        }
      }
      const failEffects: Effect[] = [
        {
          kind: 'emit',
          event: 'error',
          payload: {
            category: msg.error.category,
            code: msg.error.code,
            fatal: isCueTrack ? false : msg.error.fatal,
            recoverable: msg.error.recoverable,
            trackId: msg.trackId,
            seq: msg.seq,
            status: msg.status ?? null,
          },
        },
      ];
      // A failed media fetch must re-drive, but not synchronously: a 404
      // resolves as a microtask, and an immediate re-fetch of the same dead
      // segment would flood the loop before a recovery stage's macrotask
      // commands could intervene. A short backoff schedules the re-drive,
      // giving exclusion and skip time to change the decision. Without
      // recovery, the same segment retries until the breaker ends it.
      if (!isCueTrack) {
        failEffects.push(tickAfter('kernel:retry', cfg.baseRetryDelayMs));
      }
      return [{ ...state, cues, scheduling: { ...state.scheduling, inflight } }, failEffects];
    }

    case 'SOURCEBUFFER_CREATED': {
      const buffers = new Map(state.buffers);
      // An init that arrived before the buffer existed is held by the
      // controller and appended on creation, so the buffer opens already
      // initialized for that rendition.
      const held = state.scheduling.pendingInit?.get(msg.sbId);
      buffers.set(msg.sbId, {
        codecs: msg.codecs,
        ranges: [],
        pendingAppends: 0,
        ...(held !== undefined ? { initFor: held } : {}),
      });
      const scheduling = withPendingInit(
        state.scheduling,
        withoutPendingInit(state.scheduling.pendingInit, msg.sbId),
      );
      return [{ ...state, buffers, scheduling }, []];
    }

    case 'SOURCEBUFFER_UPDATEEND': {
      const buffer = state.buffers.get(msg.sbId);
      if (buffer === undefined) {
        // The buffer was removed by a concurrent detach. Absorb and ignore.
        return [state, []];
      }
      // Content the buffer lost takes the memory of its segments with it.
      // Every removal reports here: a switch's flush, the evictor dropping
      // forward buffer under quota, the browser's own eviction during an
      // append. Those segments are gone and a fetch restores them, where a
      // segment that never left a usable range stays remembered.
      let appended = buffer.appended;
      if (appended !== undefined && msg.ranges !== undefined) {
        const lost = lostSpans(buffer.ranges, msg.ranges);
        if (lost.length > 0) {
          appended = appended.filter(
            (seg) => !lost.some((span) => span.start <= seg.end && span.end >= seg.start),
          );
        }
      }
      const buffers = new Map(state.buffers);
      buffers.set(msg.sbId, {
        ...buffer,
        ...(msg.ranges !== undefined ? { ranges: msg.ranges } : {}),
        ...(appended !== undefined ? { appended } : {}),
        pendingAppends: Math.max(0, buffer.pendingAppends - 1),
      });
      // A successful append proves the buffer works: the breaker resets.
      let bufferErrors = state.bufferErrors;
      if (bufferErrors.has(msg.sbId)) {
        bufferErrors = new Map(bufferErrors);
        (bufferErrors as Map<string, number>).delete(msg.sbId);
      }
      // An append completing is the natural moment to decide the next fetch,
      // so the buffer keeps filling toward the goal without waiting for the
      // next time update.
      return driveScheduling({ ...state, buffers, bufferErrors }, hooks, cfg);
    }

    case 'SOURCEBUFFER_ERROR': {
      // The circuit breaker: repeated failures on one buffer can never make
      // progress, and every failure loops back into a refetch of the same
      // segment. At the limit the failure turns fatal and the loop dies.
      const count = (state.bufferErrors.get(msg.sbId) ?? 0) + 1;
      const bufferErrors = new Map(state.bufferErrors);
      bufferErrors.set(msg.sbId, count);
      // The buffer never opened, so nothing holds its init any more: the
      // next decision fetches it again.
      const scheduling = withPendingInit(
        state.scheduling,
        withoutPendingInit(state.scheduling.pendingInit, msg.sbId),
      );
      // The buffer did not keep what it was handed, or never got it: a
      // failed append, or a transform that threw before the append. The
      // parser also starts over (MSE append error algorithm, reset parser
      // state), so what the buffer received before says nothing about the
      // next append. The failed segment is fetched again, and the breaker
      // above counts it.
      let buffers = forgetAppended(state.buffers, msg.sbId);
      const fatal = msg.error.fatal || count >= cfg.bufferErrorLimit;
      const phase = fatal ? 'error' : state.lifecycle.phase;
      // A transform that threw never reached the buffer, so no updateend
      // reports for that append: this fact does. Without it the track waits
      // on the append and never schedules again. A parser error is followed
      // by its updateend (MSE append error algorithm), which reports.
      const neverAppended = msg.error.code === 'MEDIA_CONTAINER_INVALID';
      const waiting = buffers.get(msg.sbId);
      if (neverAppended && waiting !== undefined && waiting.pendingAppends > 0) {
        buffers = new Map(buffers).set(msg.sbId, {
          ...waiting,
          pendingAppends: waiting.pendingAppends - 1,
        });
      }
      const effects: Effect[] = [
        {
          kind: 'emit',
          event: 'error',
          payload: {
            category: msg.error.category,
            code: msg.error.code,
            fatal,
            recoverable: msg.error.recoverable,
            sbId: msg.sbId,
            ...(fatal && !msg.error.fatal ? { consecutiveFailures: count } : {}),
          },
        },
      ];
      if (neverAppended && !fatal) {
        // Nothing else re-drives: the refetch waits the same backoff a
        // failed fetch does, so recovery can change the decision first.
        effects.push(tickAfter('kernel:retry', cfg.baseRetryDelayMs));
      }
      let inflight: ReadonlyMap<string, InflightRequest> = state.scheduling.inflight;
      if (fatal) {
        // Stop the world for this buffer: whatever is in flight will only
        // feed the same failure again.
        const pruned = new Map(state.scheduling.inflight);
        for (const [token, request] of state.scheduling.inflight) {
          if (request.sbId === msg.sbId) {
            effects.push({ kind: 'abort', token });
            pruned.delete(token);
          }
        }
        inflight = pruned;
      }
      return [
        {
          ...state,
          buffers,
          bufferErrors,
          lifecycle: { phase },
          scheduling: { ...scheduling, inflight },
        },
        effects,
      ];
    }

    case 'QUOTA_EXCEEDED': {
      const boundary = Math.max(0, state.playback.currentTime - cfg.backBufferSeconds);
      if (boundary <= 0) {
        // Nothing behind the playhead to evict. Report; recovery is a stage.
        return [state, [{ kind: 'emit', event: 'quota:exhausted', payload: { sbId: msg.sbId } }]];
      }
      return [state, [{ kind: 'remove', sbId: msg.sbId, start: 0, end: boundary }]];
    }

    case 'TIME_UPDATE': {
      const moved: KernelState = {
        ...state,
        playback: { ...state.playback, currentTime: msg.currentTime, buffered: msg.buffered },
      };
      return driveScheduling(moved, hooks, cfg);
    }

    case 'SEEKING': {
      // Seeking out of the ended phase resumes an ordinary ready state.
      const phase = state.lifecycle.phase === 'ended' ? 'ready' : state.lifecycle.phase;
      // A seek starts the decisions over: what the buffers last received
      // no longer says anything about what the playhead needs.
      return [
        {
          ...state,
          lifecycle: { phase },
          buffers: forgetAppended(state.buffers),
          playback: { ...state.playback, currentTime: msg.to, seeking: true },
        },
        [],
      ];
    }

    case 'SEEKED': {
      return [
        { ...state, playback: { ...state.playback, currentTime: msg.at, seeking: false } },
        [],
      ];
    }

    case 'STALLED': {
      // A stall before the first timeupdate (play pressed at a position
      // with no data, say) is the first the kernel hears of what the
      // element holds. Refresh the buffered view so recovery can act on it.
      const stalled: KernelState =
        msg.buffered !== undefined
          ? {
              ...state,
              playback: { ...state.playback, currentTime: msg.at, buffered: msg.buffered },
            }
          : state;
      return [stalled, [{ kind: 'emit', event: 'playback:stalled', payload: { at: msg.at } }]];
    }

    case 'ENCRYPTED': {
      return [
        state,
        [
          {
            kind: 'emit',
            event: 'drm:encrypted',
            payload: { initDataType: msg.initDataType, initData: msg.initData },
          },
        ],
      ];
    }

    case 'LIVE_WINDOW_CHANGED': {
      const firstWindow = state.live === null;
      const withLive: KernelState = {
        ...state,
        live: { span: { start: msg.start, end: msg.end }, edge: msg.edge },
      };
      // The availability span is what the element may seek within. MSE
      // derives `seekable` from the duration unless told otherwise, so a
      // live presentation without a declared duration gets an infinite one
      // on its first span and the span itself as the seekable range on
      // every update. Native controls then scrub the DVR span and clamp
      // seeks into it, instead of offering 0 to the buffered end.
      const spanEffects: Effect[] = [];
      if (firstWindow && state.presentation?.duration === undefined) {
        spanEffects.push({ kind: 'setDuration', seconds: Number.POSITIVE_INFINITY });
      }
      spanEffects.push({ kind: 'setLiveSeekableRange', start: msg.start, end: msg.end });
      // On the first availability update of a live stream, start at the live
      // edge instead of the beginning of what can be a long DVR span (hours
      // behind). The playhead moves to the edge, the element seeks there, and
      // scheduling then fills the buffer at the edge, not at the span start.
      if (firstWindow && msg.edge > state.playback.currentTime + 1) {
        const seeked: KernelState = {
          ...withLive,
          playback: { ...withLive.playback, currentTime: msg.edge },
        };
        const [scheduled, effects] = driveScheduling(seeked, hooks, cfg);
        return [scheduled, [...spanEffects, { kind: 'seekElement', to: msg.edge }, ...effects]];
      }
      const [scheduled, effects] = driveScheduling(withLive, hooks, cfg);
      return [scheduled, [...spanEffects, ...effects]];
    }

    case 'TICK': {
      // Slices own their tokens; the kernel has nothing to do.
      return [state, []];
    }

    case 'ENDED': {
      if (state.lifecycle.phase !== 'ready') return [state, []];
      return [
        { ...state, lifecycle: { phase: 'ended' } },
        [{ kind: 'emit', event: 'playback:ended', payload: { at: msg.at } }],
      ];
    }

    case 'THROUGHPUT_SAMPLE': {
      return [
        {
          ...state,
          stats: {
            throughputEwma: ewma(state.stats.throughputEwma, msg.bps, cfg.ewmaAlpha),
            throughputFastEwma: ewma(state.stats.throughputFastEwma, msg.bps, cfg.ewmaFastAlpha),
          },
        },
        [],
      ];
    }
  }
}

/**
 * Hooks resolved at composition time, closure configuration like slices
 * and config: a replay must rebuild the reducer with the same hooks.
 */
export interface ReducerHooks {
  /** The abr stage's chooser, when one is registered. */
  readonly abr?: AbrChooser | null;
  /** The switch policy codec-switch registers; the kernel default otherwise. */
  readonly switchPolicy?: SwitchPolicy | null;
  /**
   * The manifest MIME types the composition's adapters parse, normalized
   * (`Composition.manifestTypes`). A LOAD carrying a `mimeType` outside the
   * set fails before fetching. Absent, no pre-fetch check runs; the
   * unclaimed-bytes check still reports an unsupported manifest. A replay
   * must pass the same set the recording ran with.
   */
  readonly manifestTypes?: ReadonlySet<string>;
  /**
   * Whether the browser decodes a full MSE type; the facade asks the MSE
   * layer. Renditions it rejects are excluded when a manifest loads.
   * Absent, every declared codec counts as decodable. A replay must answer
   * as the recording's browser did.
   */
  readonly decodable?: (type: string) => boolean;
  /**
   * The composition's media-time probe, when one is registered. Its
   * readings arrive on SEGMENT_LOADED facts; the reducer only asks whether
   * it exists, to hold a companion track's fetch until the lead track's
   * segment settles the epoch. A replay must register one the same way.
   */
  readonly timeProbe?: MediaTimeProbe | null;
}

/**
 * The buffer-goal loop, run on TIME_UPDATE. Pure: rendition choice comes
 * from arbitration over state, buffer knowledge from the ranges snapshots
 * the updateend facts carried into state. Live presentations wait for
 * the live stages to supply availability bounds; until then nothing is
 * scheduled.
 */
function driveScheduling(state: KernelState, hooks: ReducerHooks, cfg: KernelConfig): Reduction {
  if (state.lifecycle.phase !== 'ready' || state.presentation === null) return [state, []];
  // Live schedules only once a live stage has reported availability
  // bounds; the kernel never computes an edge itself.
  if (state.presentation.isLive && state.live === null) return [state, []];

  const effects: Effect[] = [];
  const tracks: ScheduleTrackInput[] = [];
  const initFetches: Array<{
    trackId: string;
    sbId: string;
    rendition: string;
    init: NonNullable<Rendition['init']>;
  }> = [];
  let quality = state.quality;

  for (const contentType of ['video', 'audio'] as const) {
    const trackId = state.tracks.active.get(contentType);
    if (trackId === undefined) continue;
    const found = findTrackSite(state.presentation, trackId);
    if (found === null || found.track.renditions.length === 0) continue;

    const sbId = sbIdFor(contentType);
    // An append in flight means the ranges snapshot is stale: deciding on
    // it refetches the very segment being appended. Its updateend is a
    // driving fact, so waiting costs nothing.
    if ((state.buffers.get(sbId)?.pendingAppends ?? 0) > 0) continue;
    const bufferAhead =
      bufferedEndFrom(
        state.buffers.get(sbId)?.ranges ?? [],
        state.playback.currentTime,
        GAP_TOLERANCE,
      ) - state.playback.currentTime;

    // Arbitrate the rendition for this track. Memoized on quality.version:
    // TIME_UPDATE at 60 Hz reuses the last outcome until something changes.
    // With an abr chooser loaded the key also carries coarse telemetry
    // buckets, so a real throughput or buffer change re-arbitrates without
    // recomputing at frame rate.
    const memoKey =
      hooks.abr == null
        ? state.quality.version
        : `${state.quality.version}:${Math.round(state.stats.throughputEwma / 25_000)}:${Math.round(
            state.stats.throughputFastEwma / 25_000,
          )}:${Math.round(bufferAhead)}:${state.quality.active}`;
    const outcome = arbiterFor(hooks, contentType).run(
      {
        renditions: found.track.renditions,
        constraints: state.quality.constraints,
        pinned: state.quality.pinned,
        current: state.quality.active,
        couplings: state.presentation.couplings,
        activeTracks: state.tracks.active,
        availableGroups: availableGroups(state),
        abr: hooks.abr ?? null,
        telemetry: {
          throughputEwma: state.stats.throughputEwma,
          throughputFastEwma: state.stats.throughputFastEwma,
          bufferAhead,
          current: state.quality.active,
          currentTime: state.playback.currentTime,
          canSwitchTo: hooks.switchPolicy ?? canSwitchTo,
        },
      },
      memoKey,
    );
    for (const event of outcome.events) effects.push(event);
    const rendition = found.track.renditions.find((r) => r.id === outcome.result.selected);
    if (rendition === undefined) continue;
    if (contentType === 'video' && quality.active !== rendition.id) {
      quality = { ...quality, active: rendition.id };
    }

    const inflight: InflightRequest[] = [];
    for (const request of state.scheduling.inflight.values()) {
      if (request.trackId === trackId) inflight.push(request);
    }
    // The buffer request rides with the first fetch decision; while that
    // fetch is in flight the SOURCEBUFFER_CREATED fact is on its way, so
    // re-requesting every tick would spam the trace.
    if (!state.buffers.has(sbId) && inflight.length === 0) {
      const codecs = typeString(rendition.mimeType, rendition.codecs);
      effects.push({ kind: 'createSourceBuffer', sbId, codecs });
    }
    // Init before media, always: while the buffer's init is not this
    // rendition's, the only fetch this track may make is the init segment.
    // One request per track makes the ordering free.
    if (
      rendition.init !== undefined &&
      state.buffers.get(sbId)?.initFor !== rendition.id &&
      inflight.length === 0
    ) {
      // Unless its bytes already arrived and wait for the buffer to open.
      // Fetching them again is the wasted request, and a slow open would
      // repeat it until the scheduling breaker called it a loop.
      if (state.scheduling.pendingInit?.get(sbId) !== rendition.id) {
        initFetches.push({ trackId, sbId, rendition: rendition.id, init: rendition.init });
      }
      continue;
    }
    const appended = state.buffers.get(sbId)?.appended;
    tracks.push({
      trackId,
      period: found.period,
      rendition,
      ranges: state.buffers.get(sbId)?.ranges ?? [],
      sbId,
      inflight,
      ...(appended !== undefined ? { appended } : {}),
    });
  }

  // Cue pipelines schedule like media, minus everything SourceBuffer:
  // ranges come from delivered coverage, there is no init and no
  // destination id, and delivery routes through the sink instead.
  for (const contentType of ['text', 'metadata'] as const) {
    const trackId = state.tracks.active.get(contentType);
    if (trackId === undefined) continue;
    const found = findTrackSite(state.presentation, trackId);
    const rendition = found?.track.renditions[0];
    if (found === null || rendition === undefined) continue;
    const inflight: InflightRequest[] = [];
    for (const request of state.scheduling.inflight.values()) {
      if (request.trackId === trackId) inflight.push(request);
    }
    tracks.push({
      trackId,
      period: found.period,
      rendition,
      ranges: state.cues.get(trackId) ?? [],
      inflight,
    });
  }

  // The lead buffer settles each epoch's offset: video when the
  // presentation has it, else audio. Its init and media requests count as
  // pending, so a companion track cannot settle the epoch from its own
  // bytes while the lead is still on its way there.
  const leadSbId = sbIdFor(state.tracks.active.has('video') ? 'video' : 'audio');
  const leadPending =
    initFetches.some((pending) => pending.sbId === leadSbId) ||
    [...state.scheduling.inflight.values()].some((request) => request.sbId === leadSbId);
  const result = schedule({
    currentTime: state.playback.currentTime,
    bufferGoal: state.scheduling.bufferGoal,
    tokenSeq: state.scheduling.tokenSeq + initFetches.length,
    tracks,
    liveWindow: state.presentation.isLive ? (state.live?.span ?? null) : null,
    reconciles: hooks.timeProbe != null,
    leadSbId,
    reconciled: state.timeline.reconciled,
    leadPending,
  });

  // The scheduling breaker: an identical decision repeated past the limit
  // means appends report success but nothing ever progresses, and the
  // engine would fetch the same bytes forever. Halt fatally instead.
  const decisionKey = [
    ...initFetches.map((p) => `${p.trackId}:init:${p.rendition}`),
    ...result.requests.map((r) => `${r.trackId}:${r.seq}:${r.renditionId ?? ''}`),
  ].join('|');
  let repeat = state.scheduling.repeat;
  if (decisionKey !== '') {
    repeat =
      repeat !== undefined && repeat.key === decisionKey
        ? { key: decisionKey, count: repeat.count + 1 }
        : { key: decisionKey, count: 1 };
    if (repeat.count > cfg.repeatFetchLimit) {
      effects.push({
        kind: 'emit',
        event: 'error',
        payload: {
          category: 'internal',
          code: 'INTERNAL_ASSERTION',
          fatal: true,
          recoverable: false,
          context: { reason: 'the same fetch decision repeated without progress', decisionKey },
        },
      });
      return [
        {
          ...state,
          quality,
          lifecycle: { phase: 'error' },
          scheduling: { ...state.scheduling, repeat },
        },
        effects,
      ];
    }
  }

  let tokenSeq = state.scheduling.tokenSeq;
  const inflight = new Map(state.scheduling.inflight);
  for (const pending of initFetches) {
    tokenSeq += 1;
    const token = `t${tokenSeq}:${pending.trackId}:init`;
    effects.push({
      kind: 'fetch',
      token,
      url: pending.init.url,
      ...(pending.init.byteRange !== undefined ? { range: pending.init.byteRange } : {}),
    });
    inflight.set(token, {
      token,
      trackId: pending.trackId,
      seq: -1,
      url: pending.init.url,
      sbId: pending.sbId,
      renditionId: pending.rendition,
    });
  }
  for (const effect of result.effects) effects.push(effect);
  for (const request of result.requests) {
    inflight.set(request.token, request);
  }

  // VOD end: every track has nothing left to fetch and the buffers reach
  // the announced duration. endOfStream is safe to re-emit; the handler
  // no-ops once the source has left 'open'.
  // Only SourceBuffer tracks gate the end: a subtitle playlist shorter
  // than the video must not hold the stream open.
  const mediaTracks = tracks.filter((track) => track.sbId !== undefined);
  if (
    state.presentation.duration !== undefined &&
    initFetches.length === 0 &&
    result.effects.length === 0 &&
    mediaTracks.length > 0 &&
    mediaTracks.every((track) => {
      const end = bufferedEndFrom(track.ranges, state.playback.currentTime, 0.25);
      return end >= (state.presentation?.duration ?? 0) - 0.5;
    })
  ) {
    effects.push({ kind: 'endOfStream' });
  }

  if (effects.length === 0 && quality === state.quality) return [state, []];
  return [
    {
      ...state,
      quality,
      scheduling: {
        ...state.scheduling,
        inflight,
        tokenSeq: result.tokenSeq,
        ...(repeat !== undefined ? { repeat } : {}),
      },
    },
    effects,
  ];
}

// One arbiter per hooks identity and content type: reducers built by
// createReducer share the memo across reductions, which is what makes
// 60 Hz cheap; video and audio arbitrate over different rendition sets and
// must not share a cache line.
type ArbiterPair = {
  video: ReturnType<typeof createArbiter>;
  audio: ReturnType<typeof createArbiter>;
};
const arbiters = new WeakMap<ReducerHooks, ArbiterPair>();
function arbiterFor(hooks: ReducerHooks, contentType: 'video' | 'audio') {
  let pair = arbiters.get(hooks);
  if (pair === undefined) {
    pair = { video: createArbiter(), audio: createArbiter() };
    arbiters.set(hooks, pair);
  }
  return pair[contentType];
}

const COMMAND_TYPES: Record<Command['type'], true> = {
  ATTACH: true,
  DETACH: true,
  LOAD: true,
  UNLOAD: true,
  SUSPEND: true,
  RESUME: true,
  SEEK: true,
  SEEK_TO_LIVE_EDGE: true,
  DESELECT_TRACK: true,
  SELECT_TRACK: true,
  PIN_RENDITION: true,
  RELEASE_PIN: true,
  CONSTRAIN: true,
  RELEASE_CONSTRAINT: true,
  SET_BUFFER_GOAL: true,
  ABORT_INFLIGHT: true,
};

export function isCommand(msg: Message): msg is Command {
  return msg.type in COMMAND_TYPES;
}

/**
 * Builds the root reducer from the built-in kernel logic plus stage slices.
 * A slice reducer receives its own slice (undefined on first run) and a
 * read-only view of kernel state. A throwing slice reducer is contained: its
 * slice keeps the previous value and an error event effect is emitted, so
 * one broken stage cannot corrupt kernel state.
 */
export function createReducer(
  slices?: Iterable<readonly [string, SliceReducer]>,
  config?: Partial<KernelConfig>,
  hooks: ReducerHooks = {},
): Reducer {
  const sliceList: ReadonlyArray<readonly [string, SliceReducer]> = slices ? [...slices] : [];
  const cfg = resolveConfig(config);
  const DRIVING_FACTS = new Set([
    'MANIFEST_LOADED',
    'PLAYLIST_REFRESHED',
    'SEGMENT_LOADED',
    // A buffer that opens holding an init unblocks media scheduling, and
    // nothing else would drive it on a paused element.
    'SOURCEBUFFER_CREATED',
    'SOURCEBUFFER_UPDATEEND',
    'SEEKING',
    'SEEKED',
    'LIVE_WINDOW_CHANGED',
    // A failed fetch re-drives on a scheduled backoff TICK, not synchronously,
    // so recovery's commands change the decision before the retry fires.
    'TICK',
  ]);
  return (state, msg) => {
    // Manifest bytes answer exactly one request; the kernel notes which so
    // it can tell, after the slices ran, whether any adapter claimed them.
    const manifestRequest =
      !isCommand(msg) && msg.type === 'SEGMENT_LOADED' ? manifestRequestFor(state, msg) : null;
    let [next, effects] = isCommand(msg)
      ? reduceCommand(state, msg, cfg, hooks)
      : reduceFact(state, msg, cfg, hooks);
    // A rejected command stops here. Acceptance is decided once, in the
    // kernel branch; a slice that saw the refused command would act on an
    // intent the kernel did not, and every slice would have to read the
    // phase to tell the two apart. `reject` is the only producer of this
    // event inside the reducer, and it never changes state.
    if (
      isCommand(msg) &&
      effects.some((effect) => effect.kind === 'emit' && effect.event === 'command:rejected')
    ) {
      return [next, effects];
    }
    // The buffer-goal loop runs on every fact that can change what to
    // fetch next. TIME_UPDATE drives inside its own reduction; the others
    // drive here, which is what makes startup work on a paused element
    // that fires no timeupdate.
    // A refresh that merged nothing changes nothing to drive.
    const merged = msg.type !== 'PLAYLIST_REFRESHED' || next.presentation !== state.presentation;
    if (!isCommand(msg) && DRIVING_FACTS.has(msg.type) && merged) {
      const [driven, driveEffects] = driveScheduling(next, hooks, cfg);
      next = driven;
      if (driveEffects.length > 0) effects = [...effects, ...driveEffects];
    }
    // An adapter claims manifest bytes by acting on them: a loop-back feed
    // of MANIFEST_LOADED or MANIFEST_FAILED, or a further fetch. Events are
    // observation, not a claim. Bytes nobody acts on would otherwise leave
    // the engine in `loading` forever, or misreport as a parse failure.
    let claimed = manifestRequest === null;
    for (const [name, slice] of sliceList) {
      try {
        const [sliceState, sliceEffects] = slice(next[name], msg, next);
        next = { ...next, [name]: sliceState };
        if (sliceEffects.length > 0) {
          effects = [...effects, ...sliceEffects];
          if (sliceEffects.some((effect) => effect.kind !== 'emit')) claimed = true;
        }
      } catch (err) {
        effects = [
          ...effects,
          {
            kind: 'emit',
            event: 'kernel:slice-error',
            payload: { slice: name, message: String(err) },
          },
        ];
      }
    }
    if (!claimed && manifestRequest !== null && next.lifecycle.phase === 'loading') {
      const [failed, failEffects] = failManifest(
        next,
        { category: 'manifest', code: 'MANIFEST_UNSUPPORTED', fatal: true, recoverable: false },
        { url: manifestRequest.url },
      );
      next = failed;
      effects = [...effects, ...failEffects];
    }
    // After the slices: a stage flushes too, recovery for one.
    const buffers = forgetFlushed(next.buffers, effects);
    if (buffers !== next.buffers) next = { ...next, buffers };
    // A failed engine starts nothing: no fetch, no timer, no append, from
    // the kernel or from any stage. Reports and aborts still go out. A
    // response or a timer already on its way lands here and ends here, so
    // every loop (playlist reloads, steering, retries) stops on its own.
    if (next.lifecycle.phase === 'error') {
      effects = effects.filter((effect) => effect.kind === 'emit' || effect.kind === 'abort');
    }
    return [next, effects];
  };
}
