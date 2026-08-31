/**
 * The engine.live surface both live adapters register. Reads come from
 * kernel state, so the two implementations are identical by construction
 * and loading both adapters is harmless.
 */
import type { StageContext } from '../types/stage.js';

declare module '../index.js' {
  interface MatteboxNamespaces {
    live: LiveApi;
  }
}

export interface LiveApi {
  /** Where seekToEdge lands, in presentation time, or null before the first window. */
  readonly edge: number | null;
  /** Seconds between the availability end and the playhead, or null. */
  readonly latency: number | null;
  readonly atEdge: boolean;
  seekToEdge(): void;
}

/** How far behind the edge still counts as at it, in seconds. */
const AT_EDGE_SLACK = 2;

export function registerLiveNamespace(ctx: StageContext): void {
  const api: LiveApi = {
    get edge() {
      return ctx.getState().live?.edge ?? null;
    },
    get latency() {
      const state = ctx.getState();
      if (state.live === null) return null;
      return state.live.span.end - state.playback.currentTime;
    },
    get atEdge() {
      const state = ctx.getState();
      if (state.live === null) return false;
      return state.playback.currentTime >= state.live.edge - AT_EDGE_SLACK;
    },
    seekToEdge() {
      ctx.dispatch({ type: 'SEEK_TO_LIVE_EDGE' });
    },
  };
  try {
    ctx.registerNamespace('live', api);
  } catch {
    // The other live adapter registered first. Both surfaces derive from
    // the same kernel state, so the existing one already answers.
  }
}
