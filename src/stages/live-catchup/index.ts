/**
 * Live catch-up: holds a target latency with small playback-rate changes,
 * so a live stream stays the same distance behind the edge after a stall
 * instead of drifting back for good. It helps every live stream, and
 * low-latency streams need it.
 *
 * - The target is the `targetLatency` option, else the manifest's hold-back,
 *   which is where playback starts: HLS PART-HOLD-BACK where the parts
 *   play, else HOLD-BACK (RFC 8216bis §4.4.3.8), DASH
 *   `@suggestedPresentationDelay`.
 * - Beyond the tolerance the rate moves with the error, within `minRate`
 *   and `maxRate`. A rate within 4% of normal keeps speech natural.
 * - No speed-up with less than `minBuffer` seconds buffered ahead, so
 *   catching up never causes a stall.
 * - Past `maxLatency` it seeks to the edge instead, but only for drift it
 *   was holding: after the viewer seeks or resumes that far behind, it
 *   stands down until playback is back at the target.
 * - Any rate the page sets (a speed menu, trick play) wins: the stage
 *   leaves the rate alone until it is 1 again. It never plays or pauses.
 * - Before the page's first user interaction it changes no rate, and only
 *   seeks. WebKit pauses media that started without a user gesture when its
 *   rate changes, and refuses to play it again
 *   (`navigator.userActivation`, HTML "Tracking user activation").
 *
 * Latency is measured to the edge as it moves on: the last known end of
 * the live window plus the time since it last moved, up to one refresh
 * period, so a window that updates every few seconds does not read as a
 * latency that jumps by that much.
 */
import type { Stage } from '../../types/stage.js';

export interface LiveCatchupOptions {
  /** Seconds behind the live edge to hold. Absent: the manifest's hold-back. */
  readonly targetLatency?: number;
  /** The slowest rate, used when playback is closer to the edge than the target. Defaults to 0.96. */
  readonly minRate?: number;
  /** The fastest rate, used when playback is behind the target. Defaults to 1.04. */
  readonly maxRate?: number;
  /** Seconds the latency may differ from the target before the rate changes. Defaults to 0.2. */
  readonly tolerance?: number;
  /** Seconds of latency past which the stage seeks to the edge. Defaults to three targets. */
  readonly maxLatency?: number;
  /** Seconds of buffer ahead below which the stage does not speed up. Defaults to 0.5. */
  readonly minBuffer?: number;
}

export interface CatchupApi {
  /** The latency the stage holds, in seconds, or null when nothing live plays. */
  readonly target: number | null;
  /** Seconds from the moving live edge to the playhead, or null when nothing live plays. */
  readonly latency: number | null;
  /** The rate the stage last set; 1 while it does not act. */
  readonly rate: number;
  /** Whether the stage holds the target now. */
  readonly active: boolean;
  /** Sets the target latency in seconds; null returns to the manifest's. */
  setTarget(seconds: number | null): void;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    catchup: CatchupApi;
  }
}

interface Settings {
  readonly minRate: number;
  readonly maxRate: number;
  readonly tolerance: number;
  readonly minBuffer: number;
}

/**
 * The rate for a latency error, pure. One second of error reaches the
 * bound, so the rate changes smoothly and the correction slows as the
 * latency nears the target.
 */
export function catchupRate(
  latency: number,
  target: number,
  bufferAhead: number,
  settings: Settings,
): number {
  const error = latency - target;
  if (Math.abs(error) <= settings.tolerance) return 1;
  if (error > 0) {
    if (bufferAhead < settings.minBuffer) return 1;
    return Math.min(settings.maxRate, 1 + error * (settings.maxRate - 1));
  }
  return Math.max(settings.minRate, 1 + error * (1 - settings.minRate));
}

/** Rates closer than this count as the same, so the element gets no ratechange for nothing. */
const RATE_STEP = 0.005;

/**
 * Whether the page had a user interaction. Browsers without
 * `navigator.userActivation` (before Safari 16.4) count as yes.
 */
function activated(): boolean {
  const activation = (
    globalThis.navigator as { userActivation?: { hasBeenActive: boolean } } | undefined
  )?.userActivation;
  return activation === undefined || activation.hasBeenActive;
}

export default function liveCatchup(options: LiveCatchupOptions = {}): Stage {
  const settings: Settings = {
    minRate: options.minRate ?? 0.96,
    maxRate: options.maxRate ?? 1.04,
    tolerance: options.tolerance ?? 0.2,
    minBuffer: options.minBuffer ?? 0.5,
  };
  return {
    name: 'live-catchup',
    provides: ['live-catchup'],
    install(ctx) {
      const element = ctx.element;
      let chosen: number | null = options.targetLatency ?? null;
      /** The rate this stage set last, or null when the element's rate is not ours. */
      let ours: number | null = null;
      let active = true;
      let selfSeek = false;
      let knownEnd: number | null = null;
      let movedAt = 0;

      const now = (): number => performance.now() / 1000;

      function live(): { end: number; edge: number; period: number } | null {
        const state = ctx.getState();
        if (state.live === null || state.presentation?.isLive !== true) return null;
        return {
          end: state.live.span.end,
          edge: state.live.edge,
          period: state.presentation.live?.updatePeriod ?? 2,
        };
      }

      function latency(): number | null {
        const window = live();
        if (window === null) return null;
        if (window.end !== knownEnd) {
          knownEnd = window.end;
          movedAt = now();
        }
        return window.end + Math.min(now() - movedAt, window.period) - element.currentTime;
      }

      function target(): number | null {
        const window = live();
        if (window === null) return null;
        return chosen ?? Math.max(0, window.end - window.edge);
      }

      function bufferAhead(): number {
        const time = element.currentTime;
        const ranges = element.buffered;
        for (let i = 0; i < ranges.length; i += 1) {
          if (ranges.start(i) <= time + 0.1 && ranges.end(i) > time) return ranges.end(i) - time;
        }
        return 0;
      }

      function setRate(rate: number, current: number | null, goal: number | null): void {
        if (Math.abs(element.playbackRate - rate) < RATE_STEP) return;
        element.playbackRate = rate;
        ours = rate;
        ctx.emit('catchup:rate', { rate, latency: current, target: goal });
      }

      /** Gives the element back its normal rate, when the rate is still ours. */
      function release(): void {
        if (ours !== null && element.playbackRate === ours) setRate(1, latency(), target());
        ours = null;
      }

      function maxLatency(goal: number): number {
        return options.maxLatency ?? 3 * Math.max(goal, 1);
      }

      const onTime = (): void => {
        const current = latency();
        const goal = target();
        if (current === null || goal === null) {
          release();
          return;
        }
        // The page's rate wins until it is back to normal.
        const rate = element.playbackRate;
        if (rate !== 1 && (ours === null || Math.abs(rate - ours) >= RATE_STEP)) {
          ours = null;
          return;
        }
        if (!active) {
          // Back at the target, by a seek to the edge or the viewer's own.
          if (current <= goal + settings.tolerance) active = true;
          else return;
        }
        if (element.paused || element.seeking) return;
        if (current > maxLatency(goal)) {
          selfSeek = true;
          release();
          ctx.emit('catchup:seek', { latency: current, target: goal });
          ctx.dispatch({ type: 'SEEK_TO_LIVE_EDGE' });
          return;
        }
        if (!activated()) return;
        setRate(catchupRate(current, goal, bufferAhead(), settings), current, goal);
      };

      /** After the viewer moves the playhead, hold the target only if it is still near. */
      const onSettle = (): void => {
        if (selfSeek) {
          selfSeek = false;
          return;
        }
        const current = latency();
        const goal = target();
        if (current === null || goal === null) return;
        active = current <= maxLatency(goal);
        if (!active) release();
      };

      element.addEventListener('timeupdate', onTime);
      element.addEventListener('seeked', onSettle);
      element.addEventListener('play', onSettle);
      const offTrace = ctx.on('trace', (entry) => {
        // A new source starts at its own edge.
        const type = (entry as { msg: { type: string } }).msg.type;
        if (type === 'LOAD' || type === 'UNLOAD') {
          release();
          active = true;
          knownEnd = null;
        }
      });

      ctx.registerNamespace('catchup', {
        get target() {
          return target();
        },
        get latency() {
          return latency();
        },
        get rate() {
          return ours ?? 1;
        },
        get active() {
          return active && live() !== null;
        },
        setTarget(seconds: number | null) {
          chosen = seconds;
        },
      } satisfies CatchupApi);

      return () => {
        element.removeEventListener('timeupdate', onTime);
        element.removeEventListener('seeked', onSettle);
        element.removeEventListener('play', onSettle);
        offTrace();
        release();
      };
    },
  };
}
