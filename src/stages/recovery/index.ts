/**
 * Recovery as a stage: the kernel keeps its circuit breakers as the last
 * line, and this stage acts earlier through ordinary messages and its own
 * constraint source. Nothing here is a private hook: exclusions are
 * CONSTRAIN commands, jumps are SEEK commands, flushes are remove effects,
 * and every decision is a trace entry.
 *
 * The escalation ladder for a failing segment: the transport already
 * retried; a second failure on the same rendition excludes it under the
 * 'recovery' source (readmitted after a backoff); a segment failing across
 * renditions is a hole in the content and gets seeked over.
 *
 * The ladder for a stall with data ahead, fed by the waiting event and the
 * kernel's playback watchdog: wait once, nudge the playhead, flush the
 * buffers from the playhead and refetch, then skip past the segment.
 */
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';

export interface RecoveryOptions {
  /** Failures on one rendition before it is excluded. */
  readonly excludeAfter: number;
  /** Seconds an excluded rendition sits out before readmission. */
  readonly readmitAfterSeconds: number;
  /** Failures on one segment across renditions before it is seeked over. */
  readonly skipAfter: number;
  /** Consecutive content-hole skips with no successful load before deferring to the breaker. */
  readonly maxConsecutiveSkips: number;
  /** Largest buffered hole a stall may jump, in seconds. */
  readonly maxGapSeconds: number;
}

const DEFAULTS: RecoveryOptions = {
  excludeAfter: 2,
  readmitAfterSeconds: 15,
  skipAfter: 3,
  maxConsecutiveSkips: 3,
  maxGapSeconds: 2,
};

const READMIT_TOKEN = 'recovery:readmit';

interface RecoverySlice {
  readonly renditionFails: Readonly<Record<string, number>>;
  readonly seqFails: Readonly<Record<string, number>>;
  readonly excluded: readonly string[];
  readonly readmitPending: boolean;
  /** Last gap-jump target; the same hole is never jumped twice. */
  readonly lastJump: number | null;
  /** Consecutive stalls at one position with data ahead: the rung of the ladder. */
  readonly stall: { readonly at: number; readonly count: number } | null;
  /** Flush-and-refetch attempts this attachment. */
  readonly flushes: number;
  /** Skips with no successful load since; a dead network must stop skipping and let the breaker end it. */
  readonly skips: number;
}

const INITIAL: RecoverySlice = {
  renditionFails: {},
  seqFails: {},
  excluded: [],
  readmitPending: false,
  lastJump: null,
  stall: null,
  flushes: 0,
  skips: 0,
};

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'recovery:loopback', delayMs: 0, then: message };
}

function constrainExcluded(excluded: readonly string[]): Effect {
  return excluded.length === 0
    ? feed({ type: 'RELEASE_CONSTRAINT', source: 'recovery' })
    : feed({ type: 'CONSTRAIN', source: 'recovery', constraint: { excludeIds: excluded } });
}

function isCueTrack(kernel: Readonly<KernelState>, trackId: string): boolean {
  for (const period of kernel.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      if (track.id === trackId) {
        return track.contentType === 'text' || track.contentType === 'metadata';
      }
    }
  }
  return false;
}

function segmentWindow(
  kernel: Readonly<KernelState>,
  seq: number,
): { start: number; end: number } | null {
  for (const period of kernel.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (!Array.isArray(rendition.segments)) continue;
        const segment = rendition.segments.find((s) => s.seq === seq);
        if (segment !== undefined) {
          return { start: segment.start, end: segment.start + segment.duration };
        }
      }
    }
  }
  return null;
}

/** The segment of the active video rendition that covers `time`. */
function segmentAt(
  kernel: Readonly<KernelState>,
  time: number,
): { start: number; end: number } | null {
  const active = kernel.quality.active;
  for (const period of kernel.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      if (track.contentType !== 'video') continue;
      for (const rendition of track.renditions) {
        if (active !== null && rendition.id !== active) continue;
        if (!Array.isArray(rendition.segments)) continue;
        const segment = rendition.segments.find(
          (s) => s.start <= time && time < s.start + s.duration,
        );
        if (segment !== undefined) {
          return { start: segment.start, end: segment.start + segment.duration };
        }
      }
    }
  }
  return null;
}

function createRecoveryReducer(options: RecoveryOptions): SliceReducer<RecoverySlice> {
  return (slice, msg, kernel) => {
    const state = slice ?? INITIAL;

    if (msg.type === 'DETACH' || msg.type === 'UNLOAD' || msg.type === 'LOAD') {
      return [INITIAL, msg.type === 'LOAD' ? [] : []];
    }

    if (msg.type === 'SEGMENT_FAILED') {
      // Manifest and steering fetches have their own loops; cue tracks
      // already degrade on their own.
      if (msg.renditionId === undefined || isCueTrack(kernel, msg.trackId)) return [state, []];
      const effects: Effect[] = [];
      const renditionFails = {
        ...state.renditionFails,
        [msg.renditionId]: (state.renditionFails[msg.renditionId] ?? 0) + 1,
      };
      const seqKey = `${msg.trackId}:${msg.seq}`;
      const seqFails = { ...state.seqFails, [seqKey]: (state.seqFails[seqKey] ?? 0) + 1 };
      let excluded = state.excluded;
      let readmitPending = state.readmitPending;

      // A hole in the content: the same segment fails no matter which
      // rendition serves it. Seek over it rather than dying on it. Capped
      // at maxConsecutiveSkips without a successful load, so a dead network
      // stops skipping forward and lets the kernel breaker end it — each
      // skip moves currentTime, which would otherwise reset that breaker.
      if (
        (seqFails[seqKey] as number) >= options.skipAfter &&
        state.skips < options.maxConsecutiveSkips
      ) {
        const window = segmentWindow(kernel, msg.seq);
        if (window !== null && kernel.playback.currentTime < window.end) {
          effects.push(
            { kind: 'emit', event: 'recovery:skip', payload: { seq: msg.seq, to: window.end } },
            feed({ type: 'SEEK', to: window.end + 0.1 }),
          );
          return [{ ...state, renditionFails, seqFails: {}, skips: state.skips + 1 }, effects];
        }
      }

      // Exclude a repeatedly failing rendition while alternatives exist;
      // the arbitration drop rule keeps even a fully excluded ladder
      // playable, so the breaker stays reachable when everything is dead.
      if (
        (renditionFails[msg.renditionId] as number) >= options.excludeAfter &&
        !excluded.includes(msg.renditionId)
      ) {
        excluded = [...excluded, msg.renditionId];
        effects.push(
          { kind: 'emit', event: 'recovery:excluded', payload: { renditionId: msg.renditionId } },
          constrainExcluded(excluded),
        );
        if (!readmitPending) {
          effects.push({
            kind: 'schedule',
            token: READMIT_TOKEN,
            delayMs: options.readmitAfterSeconds * 1000,
            // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
            then: { type: 'TICK', token: READMIT_TOKEN },
          });
          readmitPending = true;
        }
      }
      return [{ ...state, renditionFails, seqFails, excluded, readmitPending }, effects];
    }

    if (msg.type === 'SEGMENT_LOADED' && msg.trackId !== 'manifest') {
      // Real progress: clear the failing streak for whatever loaded and
      // re-arm the skip budget.
      const rendition = kernel.quality.active;
      const clearedFails = rendition !== null && (state.renditionFails[rendition] ?? 0) > 0;
      if (clearedFails || state.skips > 0) {
        const renditionFails = { ...state.renditionFails };
        if (rendition !== null) delete renditionFails[rendition];
        return [{ ...state, renditionFails, skips: 0 }, []];
      }
      return [state, []];
    }

    if (msg.type === 'TICK' && msg.token === READMIT_TOKEN) {
      // Backoff elapsed: readmit the oldest exclusion for another chance.
      const [readmitted, ...rest] = state.excluded;
      if (readmitted === undefined) return [{ ...state, readmitPending: false }, []];
      const renditionFails = { ...state.renditionFails };
      delete renditionFails[readmitted];
      const effects: Effect[] = [
        { kind: 'emit', event: 'recovery:readmitted', payload: { renditionId: readmitted } },
        constrainExcluded(rest),
      ];
      let readmitPending = false;
      if (rest.length > 0) {
        effects.push({
          kind: 'schedule',
          token: READMIT_TOKEN,
          delayMs: options.readmitAfterSeconds * 1000,
          // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
          then: { type: 'TICK', token: READMIT_TOKEN },
        });
        readmitPending = true;
      }
      return [{ ...state, excluded: rest, renditionFails, readmitPending }, effects];
    }

    if (msg.type === 'SEEKING') {
      // A seek elsewhere starts over: the hole it may land in is allowed a
      // jump even if it is the one jumped before. A seek within half a
      // second of the last jump is that jump landing, and keeps the guard.
      // The stall ladder is left alone: its own rungs seek too.
      const own = state.lastJump !== null && Math.abs(msg.to - state.lastJump) <= 0.5;
      return [own ? state : { ...state, lastJump: null }, []];
    }

    if (msg.type === 'STALLED') {
      const buffered = kernel.playback.buffered;
      const inRange = buffered.find(
        (range) => range.start <= msg.at + 0.3 && range.end > msg.at + 1,
      );
      if (inRange !== undefined) {
        // Data is there and the decoder is not moving. The ladder climbs one
        // rung per repeated stall at the same spot: a hiccup gets patience, a
        // stuck decoder a nudge, a poisoned buffer a flush and refetch, and
        // a segment that will not decode no matter what gets skipped.
        const count =
          state.stall !== null && Math.abs(state.stall.at - msg.at) < 0.3
            ? state.stall.count + 1
            : 1;
        const stall = { at: msg.at, count };
        if (count === 1) return [{ ...state, stall }, []];
        if (count === 2) {
          return [
            { ...state, stall },
            [
              { kind: 'emit', event: 'recovery:nudge', payload: { at: msg.at } },
              feed({ type: 'SEEK', to: msg.at + 0.1 }),
            ],
          ];
        }
        if (count === 3) {
          const effects: Effect[] = [
            { kind: 'emit', event: 'recovery:flush', payload: { at: msg.at } },
          ];
          for (const sbId of kernel.buffers.keys()) {
            effects.push({ kind: 'remove', sbId, start: msg.at, end: Number.POSITIVE_INFINITY });
          }
          effects.push(feed({ type: 'SEEK', to: msg.at }));
          return [{ ...state, stall }, effects];
        }
        if (count === 4) {
          const window = segmentAt(kernel, msg.at);
          if (window !== null) {
            return [
              { ...state, stall },
              [
                {
                  kind: 'emit',
                  event: 'recovery:skip',
                  payload: { at: msg.at, to: window.end },
                },
                feed({ type: 'SEEK', to: window.end + 0.1 }),
              ],
            ];
          }
        }
        // Out of rungs: stop acting on this spot and let the breaker decide.
        return [{ ...state, stall: null }, []];
      }
      // A hole just ahead of the playhead: jump it, once.
      const next = buffered
        .filter((range) => range.start > msg.at && range.start - msg.at <= options.maxGapSeconds)
        .sort((a, b) => a.start - b.start)[0];
      if (
        next !== undefined &&
        (state.lastJump === null || Math.abs(next.start - state.lastJump) > 0.5)
      ) {
        return [
          { ...state, lastJump: next.start, stall: null },
          [
            { kind: 'emit', event: 'recovery:gap-jump', payload: { from: msg.at, to: next.start } },
            feed({ type: 'SEEK', to: next.start + 0.1 }),
          ],
        ];
      }
      return [{ ...state, stall: null }, []];
    }

    if (msg.type === 'SOURCEBUFFER_ERROR') {
      // One flush-and-refetch before the kernel breaker trips: the remove
      // shrinks ranges, its updateend clears the error count and drives a
      // clean refill from the playhead.
      const count = kernel.bufferErrors.get(msg.sbId) ?? 0;
      if (count === 2 && state.flushes < 1) {
        return [
          { ...state, flushes: state.flushes + 1 },
          [
            { kind: 'emit', event: 'recovery:flush', payload: { sbId: msg.sbId } },
            {
              kind: 'remove',
              sbId: msg.sbId,
              start: kernel.playback.currentTime,
              end: Number.POSITIVE_INFINITY,
            },
            feed({ type: 'SEEK', to: kernel.playback.currentTime }),
          ],
        ];
      }
      return [state, []];
    }

    return [state, []];
  };
}

/** The stage factory. */
export default function recovery(options?: Partial<RecoveryOptions>): Stage {
  const resolved = { ...DEFAULTS, ...options };
  return {
    name: 'recovery',
    provides: ['recovery'],
    requires: ['scheduler', 'mse'],
    install(ctx) {
      ctx.reduce('recovery', createRecoveryReducer(resolved) as SliceReducer);
    },
  };
}
