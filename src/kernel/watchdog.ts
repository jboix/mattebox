/**
 * The playback watchdog. Browsers do not always fire `waiting` when the
 * decoder stops inside buffered data: a broken keyframe, a sub-frame hole
 * between two segments, or a codec change that never resumed. This clock
 * check synthesizes the same STALLED fact from the element's own state, so
 * the recovery stage sees every stall through one door. The idea is the
 * playback watcher in videojs-http-streaming; the difference is that the
 * only output here is a fact.
 */
import type { Fact } from '../types/messages.js';

/** The element members the watchdog reads. A structural subset of HTMLMediaElement, for tests. */
export interface WatchedElement {
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly currentTime: number;
  readonly buffered: { readonly length: number; start(i: number): number; end(i: number): number };
}

export interface WatchdogOptions {
  /** Check period in milliseconds. */
  readonly intervalMs?: number;
  /** Consecutive checks without progress before a STALLED fact. */
  readonly stuckChecks?: number;
}

/** Data the decoder could be consuming: a range at, or just ahead of, the playhead. */
function hasDataAhead(el: WatchedElement): boolean {
  const t = el.currentTime;
  for (let i = 0; i < el.buffered.length; i += 1) {
    if (el.buffered.end(i) > t + 0.1 && el.buffered.start(i) <= t + 2) return true;
  }
  return false;
}

/** Starts the watchdog; the returned function stops it. */
export function createPlaybackWatchdog(
  el: WatchedElement,
  absorb: (fact: Fact) => void,
  options: WatchdogOptions = {},
  timers: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (id: ReturnType<typeof setInterval>) => void;
  } = {
    // Wrapped, not referenced: a browser rejects setInterval called as a
    // method of another object.
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  },
): () => void {
  const intervalMs = options.intervalMs ?? 250;
  const stuckChecks = options.stuckChecks ?? 4;
  let lastTime = -1;
  let stuck = 0;
  const timer = timers.setInterval(() => {
    // Only a playing element that should be moving counts; paused, seeking,
    // ended, and metadata-less elements reset the streak.
    if (el.paused || el.seeking || el.ended || el.readyState < 1) {
      stuck = 0;
      lastTime = el.currentTime;
      return;
    }
    if (el.currentTime !== lastTime) {
      stuck = 0;
      lastTime = el.currentTime;
      return;
    }
    stuck += 1;
    // Underflow with nothing buffered is the scheduler's problem and needs
    // no fact; only a stop with data in reach is a stall worth reporting.
    if (stuck % stuckChecks === 0 && hasDataAhead(el)) {
      absorb({ type: 'STALLED', at: el.currentTime });
    }
  }, intervalMs);
  return () => timers.clearInterval(timer);
}
