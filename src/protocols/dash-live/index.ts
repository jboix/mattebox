/**
 * DASH live: the edge is computed, never read. Wall clock enters only as
 * fields on facts, stamped at the transport and element boundaries; the
 * slice turns availabilityStartTime plus clock skew into
 * LIVE_WINDOW_CHANGED facts and reloads the MPD on minimumUpdatePeriod.
 * UTCTiming corrects the client clock: a few seconds of drift silently
 * breaks live playback, which is why the fetch is worth its round trip.
 * The schemes (ISO/IEC 23009-1 §5.8.5.7): `direct` carries the date in its
 * value, `http-head` in the Date header of a HEAD response, and
 * `http-xsdate` and `http-iso` in the body of a GET response. As in VHS,
 * the MPD's first UTCTiming is the only one asked; without one, or when it
 * fails, the Date header of the MPD response stands in, else the client
 * clock counts as right. The clock syncs again when a reload brings a
 * changed MPD.
 */
import { scheduled, tickAfter } from '../../kernel/effects.js';
import type { Presentation } from '../../types/ir.js';
import type { SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { parse } from '../dash-cmaf/parse.js';
import { registerLiveNamespace } from '../live-shared.js';

export type { LiveApi } from '../live-shared.js';

const MPD_TOKEN = 'dash:live:mpd';
const UTC_TOKEN = 'dash:live:utc';
const TICK_TOKEN = 'dash-live:reload';
const CLOCK_TOKEN = 'dash-live:clock';

/** Fallback hold-back when the MPD suggests nothing, in seconds. */
const DEFAULT_HOLD_BACK = 10;
/** Fallback DVR depth, in seconds. */
const DEFAULT_TIME_SHIFT = 60;
/** Window movement below this is not worth a fact, in seconds. */
const WINDOW_QUANTUM = 0.5;

interface DashLiveSlice {
  readonly manifestUrl: string | null;
  /** Server minus client clock, in seconds. Null until UTCTiming answers. */
  readonly skew: number | null;
  readonly utcPending: boolean;
  readonly tickPending: boolean;
  readonly clockPending: boolean;
  readonly lastWindowEnd: number;
  /** The newest wall clock any fact carried; window arithmetic input. */
  readonly lastWallClock: number | null;
  /** SUSPEND stopped the loops; RESUME restarts them. */
  readonly suspended: boolean;
  /** Consecutive MPD reloads that failed or did not parse. A good reload clears it. */
  readonly failures: number;
  /** The MPD response's Date header minus the client clock, the fallback skew. */
  readonly mpdSkew: number | null;
  /** A hash of the last MPD text, to see a reload change it. */
  readonly mpdHash: number | null;
}

/**
 * Failed MPD reloads in a row before the load fails. Each reload already
 * carries the transport's own retries, so this is several update periods
 * of an MPD that does not answer. Without a limit the stream stops moving
 * and nothing says why; retrying forever keeps the network busy for a
 * stream that cannot play.
 */
const FAILURE_LIMIT = 4;

const INITIAL: DashLiveSlice = {
  manifestUrl: null,
  skew: null,
  utcPending: false,
  tickPending: false,
  clockPending: false,
  lastWindowEnd: -1,
  lastWallClock: null,
  suspended: false,
  failures: 0,
  mpdSkew: null,
  mpdHash: null,
};

/** FNV-1a over the bytes: tells one MPD text from the next. */
function hashOf(bytes: ArrayBuffer): number {
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(bytes)) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

/**
 * Starts a clock sync against the presentation's time server: a direct
 * date at once, a request for the others, and the MPD's own date without
 * a server or when the direct date does not parse.
 */
function syncClock(
  state: DashLiveSlice,
  server: { readonly scheme: string; readonly value: string } | undefined,
): [DashLiveSlice, Effect[]] {
  if (server === undefined) return [{ ...state, skew: state.mpdSkew ?? state.skew }, []];
  if (server.scheme.includes(':direct:')) {
    // The value is the server's date when it wrote the MPD, which the
    // client received at the newest wall clock it saw.
    const date = Date.parse(server.value);
    if (Number.isFinite(date) && state.lastWallClock !== null) {
      return [{ ...state, skew: date / 1000 - state.lastWallClock }, []];
    }
    return [{ ...state, skew: state.mpdSkew ?? state.skew }, []];
  }
  const head = server.scheme.includes(':http-head:');
  return [
    { ...state, utcPending: true },
    [
      {
        kind: 'fetch',
        token: UTC_TOKEN,
        url: server.value,
        ...(head ? { method: 'HEAD' as const } : {}),
      },
    ],
  ];
}

/** The window arithmetic; null when it cannot move or is not worth a fact. */
function windowUpdate(
  state: DashLiveSlice,
  live: NonNullable<Presentation['live']>,
): { readonly next: DashLiveSlice; readonly fact: Effect } | null {
  if (live.availabilityStart === undefined || state.lastWallClock === null) return null;
  const now = state.lastWallClock + (state.skew ?? 0);
  const end = now - live.availabilityStart;
  if (end <= 0 || Math.abs(end - state.lastWindowEnd) < WINDOW_QUANTUM) return null;
  const start = Math.max(0, end - (live.timeShiftDepth ?? DEFAULT_TIME_SHIFT));
  const edge = Math.max(start, end - (live.holdBack ?? DEFAULT_HOLD_BACK));
  return {
    next: { ...state, lastWindowEnd: end },
    fact: feed({ type: 'LIVE_WINDOW_CHANGED', start, end, edge }),
  };
}

/**
 * Whether this slice owns the presentation's live window: a dynamic MPD,
 * which ISO 23009-1 requires to carry availabilityStartTime. An HLS live
 * presentation is live too but has no availability start; its window is
 * read from playlists by hls-live, and reloading its master as an MPD on
 * a one-second clock is only noise.
 */
function drivesWindow(
  presentation: Presentation | null,
): presentation is Presentation & { readonly live: NonNullable<Presentation['live']> } {
  return presentation?.isLive === true && presentation.live?.availabilityStart !== undefined;
}

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  return scheduled('dash-live:loopback', message);
}

function tick(delaySeconds: number): Effect {
  return tickAfter(TICK_TOKEN, Math.max(500, delaySeconds * 1000));
}

/** The one-second clock loop that slides the window while playback stalls. */
function clockTick(): Effect {
  return tickAfter(CLOCK_TOKEN, 1000);
}

/**
 * An MPD reload that failed or did not parse. The next reload waits one
 * update period, as a good one would; after FAILURE_LIMIT in a row the
 * load fails.
 */
function reloadFailed(
  state: DashLiveSlice,
  presentation: Presentation | null,
  cause: string,
): [DashLiveSlice, Effect[]] {
  const failures = state.failures + 1;
  if (failures >= FAILURE_LIMIT) {
    return [
      { ...state, failures },
      [
        feed({
          type: 'MANIFEST_FAILED',
          error: {
            category: 'manifest',
            code: 'MANIFEST_REFRESH_FAILED',
            fatal: true,
            recoverable: false,
            context: { cause, attempts: failures },
          },
        }),
      ],
    ];
  }
  if (state.tickPending || state.suspended || !drivesWindow(presentation)) {
    return [{ ...state, failures }, []];
  }
  return [{ ...state, failures, tickPending: true }, [tick(presentation.live.updatePeriod ?? 4)]];
}

/** The slice reducer. `lowLatency` reloads the MPD as dash-ll reads it. */
export const createReduceDashLive =
  (lowLatency = false): SliceReducer<DashLiveSlice> =>
  (slice, msg, kernel) => {
    let state = slice ?? INITIAL;
    // Any stamped fact refreshes the clock cache first, so every later
    // branch computes with the newest wall time.
    if (
      (msg.type === 'TIME_UPDATE' || msg.type === 'SEGMENT_LOADED') &&
      msg.wallClock !== undefined
    ) {
      state = { ...state, lastWallClock: msg.wallClock };
    }
    // The MPD response's date, the fallback time source.
    if (
      msg.type === 'SEGMENT_LOADED' &&
      (msg.trackId === 'manifest' || msg.trackId === MPD_TOKEN) &&
      msg.serverDate !== undefined &&
      msg.wallClock !== undefined
    ) {
      state = { ...state, mpdSkew: msg.serverDate - msg.wallClock };
    }
    if (msg.type === 'SEGMENT_LOADED' && msg.trackId === 'manifest') {
      state = { ...state, mpdHash: hashOf(msg.bytes) };
    }

    if (msg.type === 'LOAD') return [{ ...INITIAL, manifestUrl: msg.url }, []];
    if (msg.type === 'UNLOAD' || msg.type === 'DETACH') return [INITIAL, []];

    if (msg.type === 'SUSPEND') {
      const effects: Effect[] = [];
      if (state.tickPending) effects.push({ kind: 'abort', token: TICK_TOKEN });
      if (state.clockPending) effects.push({ kind: 'abort', token: CLOCK_TOKEN });
      // An MPD reload in flight goes too. Its token is fixed, so the abort
      // finds the request or finds nothing.
      effects.push({ kind: 'abort', token: MPD_TOKEN });
      // The kernel forgot the window. Forget the last end as well, or a
      // window that barely moved during a short freeze is never reported.
      return [
        { ...state, tickPending: false, clockPending: false, lastWindowEnd: -1, suspended: true },
        effects,
      ];
    }

    if (msg.type === 'RESUME') {
      if (!state.suspended) return [state, []];
      const resumed = { ...state, suspended: false };
      if (state.manifestUrl === null || !drivesWindow(kernel.presentation)) return [resumed, []];
      // The MPD's answer restarts both loops and reports the window.
      return [resumed, [{ kind: 'fetch', token: MPD_TOKEN, url: state.manifestUrl }]];
    }

    if (msg.type === 'MANIFEST_LOADED') {
      if (!drivesWindow(msg.presentation)) return [state, []];
      const effects: Effect[] = [];
      let next = state;
      if (state.skew === null && !state.utcPending) {
        const [synced, sync] = syncClock(state, msg.presentation.live.timeServer);
        next = synced;
        effects.push(...sync);
      }
      if (!next.tickPending) {
        effects.push(tick(msg.presentation.live.updatePeriod ?? 4));
        next = { ...next, tickPending: true };
      }
      if (!next.clockPending) {
        effects.push(clockTick());
        next = { ...next, clockPending: true };
      }
      const window = windowUpdate(next, msg.presentation.live);
      if (window !== null) {
        next = window.next;
        effects.push(window.fact);
      }
      return [next, effects];
    }

    if (msg.type === 'TICK' && msg.token === CLOCK_TOKEN) {
      if (state.suspended || !drivesWindow(kernel.presentation)) {
        return [{ ...state, clockPending: false }, []];
      }
      let next: DashLiveSlice = { ...state, clockPending: true };
      if (msg.wallClock !== undefined) next = { ...next, lastWallClock: msg.wallClock };
      const effects: Effect[] = [clockTick()];
      const live = kernel.presentation.live;
      if (live !== undefined) {
        const window = windowUpdate(next, live);
        if (window !== null) {
          next = window.next;
          effects.push(window.fact);
        }
      }
      return [next, effects];
    }

    if (msg.type === 'TICK' && msg.token === TICK_TOKEN) {
      if (state.suspended || state.manifestUrl === null || !drivesWindow(kernel.presentation)) {
        return [{ ...state, tickPending: false }, []];
      }
      return [
        { ...state, tickPending: false },
        [{ kind: 'fetch', token: MPD_TOKEN, url: state.manifestUrl }],
      ];
    }

    // No time server answer: the skew stays unknown and counts as zero.
    if (msg.type === 'SEGMENT_FAILED' && msg.trackId === UTC_TOKEN) {
      return [{ ...state, skew: state.mpdSkew ?? state.skew, utcPending: false }, []];
    }

    if (msg.type === 'SEGMENT_FAILED' && msg.trackId === MPD_TOKEN) {
      return reloadFailed(state, kernel.presentation, msg.error.code);
    }

    if (msg.type === 'SEGMENT_LOADED' && msg.trackId === UTC_TOKEN) {
      const serverTime =
        msg.serverDate !== undefined
          ? msg.serverDate * 1000
          : Date.parse(new TextDecoder().decode(msg.bytes).trim());
      if (!Number.isFinite(serverTime) || msg.wallClock === undefined) {
        return [{ ...state, skew: state.mpdSkew ?? state.skew, utcPending: false }, []];
      }
      return [{ ...state, skew: serverTime / 1000 - msg.wallClock, utcPending: false }, []];
    }

    if (msg.type === 'SEGMENT_LOADED' && msg.trackId === MPD_TOKEN) {
      if (state.manifestUrl === null) return [state, []];
      const result = parse(new TextDecoder().decode(msg.bytes), state.manifestUrl, lowLatency);
      if (result.presentation === null) {
        return reloadFailed(state, kernel.presentation, result.error.code);
      }
      const effects: Effect[] = [];
      const hash = hashOf(msg.bytes);
      let next: DashLiveSlice = { ...state, failures: 0, mpdHash: hash };
      // A changed MPD syncs the clock again, as VHS does on a refresh.
      if (state.mpdHash !== null && hash !== state.mpdHash && !state.utcPending) {
        const [synced, sync] = syncClock(next, result.presentation.live?.timeServer);
        next = synced;
        effects.push(...sync);
      }
      effects.push(feed({ type: 'MANIFEST_LOADED', presentation: result.presentation }));
      if (result.presentation.isLive && result.presentation.live !== undefined) {
        const window = windowUpdate(next, result.presentation.live);
        if (window !== null) {
          next = window.next;
          effects.push(window.fact);
        }
      }
      return [next, effects];
    }

    // Every wall-clock-stamped fact can slide the window.
    if (
      (msg.type === 'TIME_UPDATE' || msg.type === 'SEGMENT_LOADED') &&
      drivesWindow(kernel.presentation)
    ) {
      const window = windowUpdate(state, kernel.presentation.live);
      if (window !== null) return [window.next, [window.fact]];
    }

    return [state, []];
  };

/** The stage factory. Requires dash-cmaf; the loader enforces it. */
export default function dashLive(): Stage {
  return {
    name: 'dash-live',
    provides: ['dash-live'],
    requires: ['dash-cmaf'],
    install(ctx) {
      ctx.reduce('dash-live', createReduceDashLive() as SliceReducer);
      registerLiveNamespace(ctx);
    },
  };
}
