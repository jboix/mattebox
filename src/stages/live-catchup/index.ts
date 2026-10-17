/**
 * Live catch-up: holds a target latency with playback-rate changes, so a
 * live stream stays the same distance behind the edge after a stall
 * instead of drifting back for good. It follows dash.js's default catch-up
 * mode, the reference for two-sided catch-up.
 *
 * - Like dash.js, it acts on a low-latency stream only (LL-HLS playing from
 *   parts, DASH with chunked segments), unless `enabled` says otherwise.
 *   hls.js leaves the rate alone by default.
 * - The target is the `targetLatency` option, else the manifest's hold-back,
 *   which is where playback starts: HLS PART-HOLD-BACK where the parts
 *   play, else HOLD-BACK (RFC 8216bis §4.4.3.8), DASH ServiceDescription
 *   Latency@target with dash-ll, else `@suggestedPresentationDelay`.
 * - The rate follows the drift d (latency minus target) on a sigmoid:
 *   1 - c + 2c / (1 + e^(-5d)), with c the distance from 1 to `maxRate`
 *   behind the target and to `minRate` ahead of it. A rate closer to the
 *   current one than a small step is not written.
 * - After a stall, the rate stays 1 until the buffer ahead holds half the
 *   target.
 * - Past `maxDrift` seconds of drift it seeks to the edge.
 * - After the viewer seeks or resumes, the target becomes the latency
 *   there, as dash.js does after its own seek and play: a viewer who moved
 *   back in the window stays where they went. A seek that lands near the
 *   target, such as `engine.live.seekToEdge()`, returns to it.
 * - It sets the rate only once the element has future data. Before the
 *   page's first user interaction it changes no rate, and only seeks:
 *   WebKit pauses media that started without a user gesture when its rate
 *   changes, and refuses to play it again (`navigator.userActivation`,
 *   HTML "Tracking user activation").
 * - A DASH ServiceDescription's PlaybackRate and Latency@max (ISO/IEC
 *   23009-1 Annex K) set the rate bounds and the maximum drift the options
 *   leave unset.
 *
 * Latency is measured to the edge as it moves on, as hls.js measures it:
 * the last known end of the live window plus the time since it last moved.
 */
import type { Presentation } from '../../types/ir.js';
import type { Stage } from '../../types/stage.js';

export interface LiveCatchupOptions {
  /** True holds every live stream, false none. Absent: low-latency streams only. */
  readonly enabled?: boolean;
  /** Seconds behind the live edge to hold. Absent: the manifest's hold-back. */
  readonly targetLatency?: number;
  /** The slowest rate, used when playback is closer to the edge than the target. Defaults to the manifest's, else 0.5. */
  readonly minRate?: number;
  /** The fastest rate, used when playback is behind the target. Defaults to the manifest's, else 1.5. */
  readonly maxRate?: number;
  /** Seconds of drift behind the target past which the stage seeks to the edge. Defaults to the manifest's, else 12. */
  readonly maxDrift?: number;
}

export interface CatchupApi {
  /** The latency the stage holds, in seconds, or null when nothing live plays. */
  readonly target: number | null;
  /** Seconds from the moving live edge to the playhead, or null when nothing live plays. */
  readonly latency: number | null;
  /** The rate the stage last set; 1 while it does not act. */
  readonly rate: number;
  /** Whether the stage acts on this stream and holds the manifest's or the page's target, not a latency the viewer moved to. */
  readonly active: boolean;
  /** Sets the target latency in seconds; null returns to the manifest's. */
  setTarget(seconds: number | null): void;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    catchup: CatchupApi;
  }
}

/** The rate bounds, as factors. */
export interface RateBounds {
  readonly minRate: number;
  readonly maxRate: number;
}

/** dash.js limits the rates to 0.5 and 2. */
const RATE_FLOOR = 0.5;
const RATE_CEILING = 2;

/**
 * The rate for a drift, pure: dash.js's default catch-up curve. It is 1 on
 * target and approaches the bound as the drift grows.
 */
export function catchupRate(latency: number, target: number, bounds: RateBounds): number {
  const drift = latency - target;
  const reach = drift < 0 ? 1 - bounds.minRate : bounds.maxRate - 1;
  return 1 - reach + (2 * reach) / (1 + Math.exp(-5 * drift));
}

/**
 * The smallest rate change worth writing: dash.js's 0.02, scaled to the
 * fastest rate, so 0.02 for a bound of 1.5 and less for a narrower one.
 */
function rateStep(bounds: RateBounds): number {
  return (0.02 * (bounds.maxRate - 1)) / 0.5;
}

/** HTMLMediaElement HAVE_FUTURE_DATA. */
const HAVE_FUTURE_DATA = 3;
/** Seconds of drift past which the stage seeks, without a manifest value (dash.js). */
const DEFAULT_MAX_DRIFT = 12;
/** A viewer's seek that lands this close to the target counts as a return to it. */
const NEAR_TARGET = 0.5;

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

function clampRate(rate: number): number {
  return Math.min(RATE_CEILING, Math.max(RATE_FLOOR, rate));
}

export default function liveCatchup(options: LiveCatchupOptions = {}): Stage {
  return {
    name: 'live-catchup',
    provides: ['live-catchup'],
    install(ctx) {
      const element = ctx.element;
      let chosen: number | null = options.targetLatency ?? null;
      /** The latency the viewer moved to, which the stage holds instead of the target. */
      let moved: number | null = null;
      /** The rate this stage set last, or null when it set none. */
      let ours: number | null = null;
      let selfSeek = false;
      /** A stall happened; the rate stays 1 until the buffer recovers. */
      let stalled = false;
      /** Playback started: the start-up seek and first play are the engine's, not the viewer's. */
      let started = false;
      let knownEnd: number | null = null;
      let movedAt = 0;

      const now = (): number => performance.now() / 1000;

      function live(): { end: number; edge: number; info: Presentation['live'] } | null {
        const state = ctx.getState();
        if (state.live === null || state.presentation?.isLive !== true) return null;
        return { end: state.live.span.end, edge: state.live.edge, info: state.presentation.live };
      }

      function latency(): number | null {
        const window = live();
        if (window === null) return null;
        if (window.end !== knownEnd) {
          knownEnd = window.end;
          movedAt = now();
        }
        return window.end + (now() - movedAt) - element.currentTime;
      }

      /** The manifest's or the page's target. */
      function baseTarget(): number | null {
        const window = live();
        if (window === null) return null;
        return chosen ?? Math.max(0, window.end - window.edge);
      }

      function target(): number | null {
        const base = baseTarget();
        return base === null ? null : (moved ?? base);
      }

      function bounds(): RateBounds {
        const rates = live()?.info?.playbackRate;
        return {
          minRate: clampRate(options.minRate ?? rates?.min ?? 0.5),
          maxRate: clampRate(options.maxRate ?? rates?.max ?? 1.5),
        };
      }

      function maxDrift(): number {
        if (options.maxDrift !== undefined) return options.maxDrift;
        const max = live()?.info?.maxLatency;
        const base = baseTarget();
        // Latency@max bounds the latency; dash.js seeks half a second past it.
        if (max !== undefined && base !== null && max > base) return max - base + 0.5;
        return DEFAULT_MAX_DRIFT;
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
        if (element.playbackRate === rate) return;
        element.playbackRate = rate;
        ours = rate;
        ctx.emit('catchup:rate', { rate, latency: current, target: goal });
      }

      /** Gives the element back its normal rate, when the stage set another. */
      function release(): void {
        if (ours !== null && ours !== 1) setRate(1, latency(), target());
        ours = null;
      }

      /** Whether catch-up applies to the stream playing. */
      function applies(): boolean {
        return options.enabled ?? live()?.info?.lowLatency === true;
      }

      const onTime = (): void => {
        const current = latency();
        const goal = target();
        if (current === null || goal === null || !applies()) {
          release();
          return;
        }
        if (element.paused || element.seeking) return;
        if (current - goal > maxDrift()) {
          selfSeek = true;
          release();
          ctx.emit('catchup:seek', { latency: current, target: goal });
          ctx.dispatch({ type: 'SEEK_TO_LIVE_EDGE' });
          return;
        }
        if (stalled && bufferAhead() > goal / 2) stalled = false;
        if (!activated() || element.readyState < HAVE_FUTURE_DATA) return;
        const range = bounds();
        const rate = stalled ? 1 : catchupRate(current, goal, range);
        if (rate === 1 || Math.abs(element.playbackRate - rate) >= rateStep(range)) {
          setRate(rate, current, goal);
        }
      };

      /** The viewer moved the playhead: hold the latency there, or the target when it is near. */
      const onSettle = (): void => {
        if (selfSeek || !started) {
          selfSeek = false;
          moved = null;
          return;
        }
        const current = latency();
        const base = baseTarget();
        if (current === null || base === null) return;
        moved = Math.abs(current - base) <= NEAR_TARGET ? null : current;
      };

      const onWaiting = (): void => {
        stalled = true;
      };

      const onPlaying = (): void => {
        started = true;
      };

      element.addEventListener('timeupdate', onTime);
      element.addEventListener('seeked', onSettle);
      element.addEventListener('play', onSettle);
      element.addEventListener('waiting', onWaiting);
      element.addEventListener('playing', onPlaying);
      const offTrace = ctx.on('trace', (entry) => {
        // A new source starts at its own edge.
        const type = (entry as { msg: { type: string } }).msg.type;
        if (type === 'LOAD' || type === 'UNLOAD') {
          release();
          moved = null;
          stalled = false;
          started = false;
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
          return moved === null && live() !== null && applies();
        },
        setTarget(seconds: number | null) {
          chosen = seconds;
          moved = null;
        },
      } satisfies CatchupApi);

      return () => {
        element.removeEventListener('timeupdate', onTime);
        element.removeEventListener('seeked', onSettle);
        element.removeEventListener('play', onSettle);
        element.removeEventListener('waiting', onWaiting);
        element.removeEventListener('playing', onPlaying);
        offTrace();
        release();
      };
    },
  };
}
