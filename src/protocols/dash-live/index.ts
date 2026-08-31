/**
 * DASH live: the edge is computed, never read. Wall clock enters only as
 * fields on facts, stamped at the transport and element boundaries; the
 * slice turns availabilityStartTime plus clock skew into
 * LIVE_WINDOW_CHANGED facts and reloads the MPD on minimumUpdatePeriod.
 * UTCTiming corrects the client clock: a few seconds of drift silently
 * breaks live playback, which is why the fetch is worth its round trip.
 */
import type { Presentation } from '../../types/ir.js';
import type { SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { parse } from '../dash-cmaf/parse.js';
import { registerLiveNamespace } from '../live-shared.js';

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
}

const INITIAL: DashLiveSlice = {
  manifestUrl: null,
  skew: null,
  utcPending: false,
  tickPending: false,
  clockPending: false,
  lastWindowEnd: -1,
  lastWallClock: null,
};

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
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'dash-live:loopback', delayMs: 0, then: message };
}

function tick(delaySeconds: number): Effect {
  return {
    kind: 'schedule',
    token: TICK_TOKEN,
    delayMs: Math.max(500, delaySeconds * 1000),
    // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
    then: { type: 'TICK', token: TICK_TOKEN },
  };
}

/** The one-second clock loop that slides the window while playback stalls. */
function clockTick(): Effect {
  return {
    kind: 'schedule',
    token: CLOCK_TOKEN,
    delayMs: 1000,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
    then: { type: 'TICK', token: CLOCK_TOKEN },
  };
}

const reduceDashLive: SliceReducer<DashLiveSlice> = (slice, msg, kernel) => {
  let state = slice ?? INITIAL;
  // Any stamped fact refreshes the clock cache first, so every later
  // branch computes with the newest wall time.
  if (
    (msg.type === 'TIME_UPDATE' || msg.type === 'SEGMENT_LOADED') &&
    msg.wallClock !== undefined
  ) {
    state = { ...state, lastWallClock: msg.wallClock };
  }

  if (msg.type === 'LOAD') return [{ ...INITIAL, manifestUrl: msg.url }, []];
  if (msg.type === 'UNLOAD' || msg.type === 'DETACH') return [INITIAL, []];

  if (msg.type === 'MANIFEST_LOADED') {
    if (!drivesWindow(msg.presentation)) return [state, []];
    const effects: Effect[] = [];
    let next = state;
    const server = msg.presentation.live.timeServer;
    if (server !== undefined && state.skew === null && !state.utcPending) {
      if (server.scheme.endsWith(':direct') || server.scheme.endsWith(':direct:2014')) {
        // The value is the date itself; skew resolves on the next fact
        // carrying a wall clock. Treated as zero until then.
        next = { ...next, skew: null };
      } else if (server.value !== '') {
        effects.push({ kind: 'fetch', token: UTC_TOKEN, url: server.value });
        next = { ...next, utcPending: true };
      }
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
    if (!drivesWindow(kernel.presentation)) {
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
    if (state.manifestUrl === null || !drivesWindow(kernel.presentation)) {
      return [{ ...state, tickPending: false }, []];
    }
    return [
      { ...state, tickPending: false },
      [{ kind: 'fetch', token: MPD_TOKEN, url: state.manifestUrl }],
    ];
  }

  if (msg.type === 'SEGMENT_LOADED' && msg.trackId === UTC_TOKEN) {
    const serverTime = Date.parse(new TextDecoder().decode(msg.bytes).trim());
    if (!Number.isFinite(serverTime) || msg.wallClock === undefined) {
      return [{ ...state, utcPending: false }, []];
    }
    return [{ ...state, skew: serverTime / 1000 - msg.wallClock, utcPending: false }, []];
  }

  if (msg.type === 'SEGMENT_LOADED' && msg.trackId === MPD_TOKEN) {
    if (state.manifestUrl === null) return [state, []];
    const result = parse(new TextDecoder().decode(msg.bytes), state.manifestUrl);
    const effects: Effect[] = [];
    let next = state;
    if (result.presentation !== null) {
      effects.push(feed({ type: 'MANIFEST_LOADED', presentation: result.presentation }));
      if (result.presentation.isLive && result.presentation.live !== undefined) {
        const window = windowUpdate(next, result.presentation.live);
        if (window !== null) {
          next = window.next;
          effects.push(window.fact);
        }
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
      ctx.reduce('dash-live', reduceDashLive as SliceReducer);
      registerLiveNamespace(ctx);
    },
  };
}
