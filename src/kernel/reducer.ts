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
import type { Presentation, Rendition, Track } from '../types/ir.js';
import type {
  InflightRequest,
  KernelConfig,
  KernelState,
  Reducer,
  SliceReducer,
} from '../types/kernel.js';
import type { Command, Effect, Fact, Message, Serializable } from '../types/messages.js';
import { normalizeMimeType } from './mime.js';
import type { AbrChooser, SwitchPolicy } from './rendition-select.js';
import { canSwitchTo, codecFamily, createArbiter, planPinApply } from './rendition-select.js';
import type { ScheduleTrackInput } from './scheduler.js';
import { bufferedEndFrom, schedule } from './scheduler.js';
import type { MediaContentType } from './sinks/mse-sink.js';
import { sbIdFor } from './sinks/mse-sink.js';
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
  mediaTimeNormalized: false,
};

export function resolveConfig(config?: Partial<KernelConfig>): KernelConfig {
  return { ...DEFAULT_KERNEL_CONFIG, ...config };
}

export function initialState(config?: Partial<KernelConfig>): KernelState {
  const cfg = resolveConfig(config);
  return {
    lifecycle: { phase: 'idle' },
    presentation: null,
    timeline: { periodOffsets: new Map(), discontinuitySeq: 0 },
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

/** Companion groups present, as `contentType:groupId`, for the coupling filter. */
function availableGroups(state: KernelState): ReadonlySet<string> {
  const groups = new Set<string>();
  for (const period of state.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      if (track.contentType !== 'audio' && track.contentType !== 'text') continue;
      const colon = track.id.indexOf(':');
      const group = colon === -1 ? track.id : track.id.slice(0, colon);
      groups.add(`${track.contentType}:${group}`);
    }
  }
  return groups;
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

function findTrack(presentation: Presentation | null, trackId: string): Track | null {
  if (presentation === null) return null;
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (track.id === trackId) return track;
    }
  }
  return null;
}

function findTrackSite(
  presentation: Presentation,
  trackId: string,
): { track: Track; period: Presentation['periods'][number] } | null {
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (track.id === trackId) return { track, period };
    }
  }
  return null;
}

interface RenditionSite {
  readonly rendition: Rendition;
  readonly track: Track;
  readonly period: Presentation['periods'][number];
}

function findRendition(
  presentation: Presentation | null,
  renditionId: string,
): RenditionSite | null {
  if (presentation === null) return null;
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) return { rendition, track, period };
      }
    }
  }
  return null;
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
      return [
        {
          ...fresh,
          lifecycle: { phase },
          scheduling: { ...fresh.scheduling, tokenSeq: state.scheduling.tokenSeq },
        },
        [...aborts, ...clears],
      ];
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
      const previous = state.tracks.active.get(track.contentType);
      const active = new Map(state.tracks.active);
      active.set(track.contentType, track.id);
      const effects: Effect[] = [];
      let buffers = state.buffers;
      let inflight = state.scheduling.inflight;
      // A media track change mid-stream must clear the old track's buffer,
      // or the new track's segment (which re-covers time the old track
      // already buffered) overlaps stale content and strict decoders
      // (WebKit) reject the append. The whole buffer goes; the new track
      // refills from the playhead's segment with a brief gap.
      if (
        previous !== undefined &&
        previous !== track.id &&
        (track.contentType === 'audio' || track.contentType === 'video')
      ) {
        const sbId = sbIdFor(track.contentType);
        if (state.buffers.has(sbId)) {
          effects.push({
            kind: 'remove',
            sbId,
            start: 0,
            end: Number.POSITIVE_INFINITY,
          });
          const buffer = state.buffers.get(sbId);
          if (buffer !== undefined) {
            // Force an init re-fetch for the new track: its initFor no
            // longer matches, so scheduling fetches init before media.
            const next = new Map(state.buffers);
            const { initFor: _initFor, ...rest } = buffer;
            next.set(sbId, rest);
            buffers = next;
          }
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
      const plan = planPinApply({
        strategy: msg.apply,
        currentTime: state.playback.currentTime,
        ranges: state.buffers.get(sbId)?.ranges ?? [],
        sbId,
        trackId: site.track.id,
        inflightTokens,
        period: site.period,
        rendition: site.rendition,
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
      const available: string[] = [];
      for (const period of msg.presentation.periods) {
        for (const track of period.tracks) available.push(track.id);
      }
      const inflight = new Map(state.scheduling.inflight);
      for (const [token, request] of inflight) {
        if (request.trackId === 'manifest') inflight.delete(token);
      }
      const phase = state.lifecycle.phase === 'loading' ? 'ready' : state.lifecycle.phase;
      // Default activation: the first video and audio track, so a manifest
      // alone yields a playable composition without a SELECT_TRACK.
      const active = new Map(state.tracks.active);
      for (const period of msg.presentation.periods) {
        for (const track of period.tracks) {
          if (
            (track.contentType === 'video' || track.contentType === 'audio') &&
            !active.has(track.contentType)
          ) {
            active.set(track.contentType, track.id);
          }
        }
      }
      const loaded: KernelState = {
        ...state,
        lifecycle: { phase },
        presentation: msg.presentation,
        scheduling: { ...state.scheduling, inflight },
        tracks: { active, available },
        quality: bumped(state.quality),
      };
      // A live reload feeds a MANIFEST_LOADED per playlist; the track list
      // only changed if the ids did.
      const sameTracks =
        available.length === state.tracks.available.length &&
        available.every((id, index) => id === state.tracks.available[index]);
      const manifestEffects: Effect[] = sameTracks
        ? []
        : [{ kind: 'emit', event: 'tracks:changed', payload: { available } }];
      // The manifest DRM route: emit every track's protection schemes so
      // eme-core (if loaded) can open sessions. Serializable init data
      // rides the event; nothing DRM-specific enters the reducer.
      const schemes = msg.presentation.periods.flatMap((period) =>
        period.tracks.flatMap((track) => track.protection?.schemes ?? []),
      );
      if (schemes.length > 0) {
        manifestEffects.push({
          kind: 'emit',
          event: 'presentation:protection',
          payload: schemes as unknown as import('../types/messages.js').Serializable,
        });
      }
      if (!msg.presentation.isLive && msg.presentation.duration !== undefined) {
        manifestEffects.push({ kind: 'setDuration', seconds: msg.presentation.duration });
      }
      return [loaded, manifestEffects];
    }

    case 'MANIFEST_FAILED':
      return failManifest(state, msg.error);

    case 'PLAYLIST_REFRESHED':
      // Merging a refreshed live playlist into the presentation belongs to
      // the protocol stages. Absorbed for the trace until they exist.
      return [state, []];

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
            const targetSite = findRendition(state.presentation, matched.renditionId);
            const targetCodecs =
              targetSite === null
                ? buffer.codecs
                : targetSite.rendition.codecs === null
                  ? targetSite.rendition.mimeType
                  : `${targetSite.rendition.mimeType}; codecs="${targetSite.rendition.codecs}"`;
            const familyChanged =
              codecFamily(targetSite?.rendition.codecs ?? null) !==
              codecFamily(bufferCodecString(buffer.codecs));
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
            scheduling: { ...state.scheduling, inflight },
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
        // The scheduler computed the epoch's offset at request time; apply
        // it ahead of the append when it differs from what the buffer has.
        // Playlist discontinuities and period boundaries both land here.
        if (
          matched.timestampOffset !== undefined &&
          state.timeline.periodOffsets.get(matched.sbId) !== matched.timestampOffset
        ) {
          effects.push({
            kind: 'setTimestampOffset',
            sbId: matched.sbId,
            offset: matched.timestampOffset,
          });
          const periodOffsets = new Map(state.timeline.periodOffsets);
          periodOffsets.set(matched.sbId, matched.timestampOffset);
          timeline = { ...state.timeline, periodOffsets };
        }
        effects.push({
          kind: 'append',
          sbId: matched.sbId,
          data: msg.bytes,
          ...(matched.segmentStart !== undefined ? { start: matched.segmentStart } : {}),
          ...(matched.renditionId !== undefined ? { renditionId: matched.renditionId } : {}),
          seq: matched.seq,
        });
        const buffer = buffers.get(matched.sbId);
        if (buffer !== undefined) {
          const nextBuffers = new Map(buffers);
          nextBuffers.set(matched.sbId, { ...buffer, pendingAppends: buffer.pendingAppends + 1 });
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
          scheduling: { ...state.scheduling, inflight },
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
        failEffects.push({
          kind: 'schedule',
          token: 'kernel:retry',
          delayMs: cfg.baseRetryDelayMs,
          // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
          then: { type: 'TICK', token: 'kernel:retry' },
        });
      }
      return [{ ...state, cues, scheduling: { ...state.scheduling, inflight } }, failEffects];
    }

    case 'SOURCEBUFFER_CREATED': {
      const buffers = new Map(state.buffers);
      buffers.set(msg.sbId, { codecs: msg.codecs, ranges: [], pendingAppends: 0 });
      return [{ ...state, buffers }, []];
    }

    case 'SOURCEBUFFER_UPDATEEND': {
      const buffer = state.buffers.get(msg.sbId);
      if (buffer === undefined) {
        // The buffer was removed by a concurrent detach. Absorb and ignore.
        return [state, []];
      }
      const buffers = new Map(state.buffers);
      buffers.set(msg.sbId, {
        ...buffer,
        ...(msg.ranges !== undefined ? { ranges: msg.ranges } : {}),
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
      const fatal = msg.error.fatal || count >= cfg.bufferErrorLimit;
      const phase = fatal ? 'error' : state.lifecycle.phase;
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
          bufferErrors,
          lifecycle: { phase },
          scheduling: { ...state.scheduling, inflight },
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
      return [
        {
          ...state,
          lifecycle: { phase },
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
      return [state, [{ kind: 'emit', event: 'playback:stalled', payload: { at: msg.at } }]];
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
      const codecs =
        rendition.codecs === null
          ? rendition.mimeType
          : `${rendition.mimeType}; codecs="${rendition.codecs}"`;
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
      initFetches.push({ trackId, sbId, rendition: rendition.id, init: rendition.init });
      continue;
    }
    tracks.push({
      trackId,
      period: found.period,
      rendition,
      ranges: state.buffers.get(sbId)?.ranges ?? [],
      sbId,
      inflight,
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

  const result = schedule({
    currentTime: state.playback.currentTime,
    bufferGoal: state.scheduling.bufferGoal,
    tokenSeq: state.scheduling.tokenSeq + initFetches.length,
    tracks,
    liveWindow: state.presentation.isLive ? (state.live?.span ?? null) : null,
    mediaTimeNormalized: cfg.mediaTimeNormalized,
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
    'SEGMENT_LOADED',
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
    // The buffer-goal loop runs on every fact that can change what to
    // fetch next. TIME_UPDATE drives inside its own reduction; the others
    // drive here, which is what makes startup work on a paused element
    // that fires no timeupdate.
    if (!isCommand(msg) && DRIVING_FACTS.has(msg.type)) {
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
    return [next, effects];
  };
}
