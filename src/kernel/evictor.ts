/**
 * QuotaExceededError recovery policy, executed against real SourceBuffer
 * ranges. The reducer decides the steady-state policy (remove behind the
 * playhead); this module plans escalating passes when one pass does not
 * free enough, then tells the owner to stop and surface a fatal error
 * rather than looping.
 *
 * "Never remove the range containing currentTime" is enforced as a keep-out
 * window around the playhead, not as the whole contiguous buffered range: a
 * VOD buffer is usually one range, and sparing all of it would make quota
 * recovery impossible.
 *
 * With ManagedMediaSource the OS signals buffering pressure through
 * startstreaming and endstreaming; the evictor listens to those instead of
 * running any eviction on its own schedule. There is no timer here at all.
 */

export interface EvictionPlanEntry {
  readonly start: number;
  readonly end: number;
}

export interface EvictorOptions {
  /** Seconds kept behind the playhead on a normal pass. */
  readonly backBufferSeconds?: number;
  /** Failed passes tolerated before the owner should surface a fatal error. */
  readonly maxPasses?: number;
}

export interface Evictor {
  /**
   * Ranges to remove for escalation pass `attempt` (1-based), computed
   * against the buffer's real ranges. Empty when nothing can be freed on
   * this pass. Null when `attempt` exceeds maxPasses: stop evicting and
   * surface a fatal error.
   */
  plan(sb: SourceBuffer, currentTime: number, attempt: number): readonly EvictionPlanEntry[] | null;
  /** Clamps an externally requested removal out of the playhead's keep-out window. */
  clamp(
    sb: SourceBuffer,
    start: number,
    end: number,
    currentTime: number,
  ): EvictionPlanEntry | null;
  /**
   * Follows ManagedMediaSource streaming signals. On endstreaming the OS
   * has what it needs; `onTrim` lets the owner run one back-buffer trim
   * then. Returns an unlisten function.
   */
  observeManaged(ms: EventTarget, onTrim: () => void): () => void;
  readonly streaming: () => boolean;
}

const DEFAULT_BACK_BUFFER = 30;
const DEFAULT_MAX_PASSES = 3;

/** Seconds behind the playhead that are never removed. */
const KEEPOUT_BEHIND_SECONDS = 1;

/** Seconds ahead of the playhead kept when the last pass drops forward buffer. */
const FORWARD_KEEP_SECONDS = 10;

export function createEvictor(options: EvictorOptions = {}): Evictor {
  const backBuffer = options.backBufferSeconds ?? DEFAULT_BACK_BUFFER;
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  let streaming = true;

  function clamp(
    _sb: SourceBuffer,
    start: number,
    end: number,
    currentTime: number,
  ): EvictionPlanEntry | null {
    // An unbounded removal is a deliberate flush-forward: a quality switch
    // clearing everything ahead of the playhead. The keep-out window
    // guards eviction and housekeeping clears, never flushes; clamping a
    // flush silently keeps the stale content and the switch never happens.
    if (end === Number.POSITIVE_INFINITY) {
      return { start, end };
    }
    const clampedEnd = Math.min(end, currentTime - KEEPOUT_BEHIND_SECONDS);
    if (clampedEnd <= start) return null;
    return { start, end: clampedEnd };
  }

  function overlapsBuffered(sb: SourceBuffer, entry: EvictionPlanEntry): boolean {
    const { buffered } = sb;
    for (let i = 0; i < buffered.length; i += 1) {
      if (entry.start < buffered.end(i) && entry.end > buffered.start(i)) return true;
    }
    return false;
  }

  return {
    clamp,
    plan(sb, currentTime, attempt) {
      if (attempt > maxPasses) return null;
      const entries: EvictionPlanEntry[] = [];
      // Pass 1 keeps the configured back-buffer, pass 2 a quarter of it,
      // pass 3 keeps only the keep-out window.
      const keep =
        attempt === 1 ? backBuffer : attempt === 2 ? backBuffer / 4 : KEEPOUT_BEHIND_SECONDS;
      const behind = clamp(sb, 0, currentTime - keep, currentTime);
      if (behind !== null) entries.push(behind);
      if (attempt >= 3) {
        // Last resort: drop forward buffer well ahead of the playhead. The
        // scheduler refetches it later; a fatal quota error does not.
        const aheadStart = currentTime + FORWARD_KEEP_SECONDS;
        const { buffered } = sb;
        const bufferedEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
        if (bufferedEnd > aheadStart) entries.push({ start: aheadStart, end: bufferedEnd });
      }
      // A removal touching nothing frees nothing, and worse: remove() on an
      // ended MediaSource re-opens it, which turns an idle trim into an
      // endless open, trim, end cycle on ManagedMediaSource.
      return entries.filter((entry) => overlapsBuffered(sb, entry));
    },
    observeManaged(ms, onTrim) {
      const onStart = (): void => {
        streaming = true;
      };
      const onEnd = (): void => {
        streaming = false;
        onTrim();
      };
      ms.addEventListener('startstreaming', onStart);
      ms.addEventListener('endstreaming', onEnd);
      return () => {
        ms.removeEventListener('startstreaming', onStart);
        ms.removeEventListener('endstreaming', onEnd);
      };
    },
    streaming: () => streaming,
  };
}
