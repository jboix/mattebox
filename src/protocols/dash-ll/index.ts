/**
 * Low-latency DASH (DASH-IF IOP low-latency modes, ISO/IEC 23009-1 Annex
 * K): dash-cmaf and dash-live in one stage, reading what a low-latency MPD
 * adds. The ServiceDescription target becomes the hold-back, and segments
 * with an `@availabilityTimeOffset` are requested before they are
 * complete. With `@availabilityTimeComplete="false"` the server sends such
 * a segment as the encoder writes it: the stage registers the CMAF chunk
 * splitter, so each complete `moof` and `mdat` pair appends as it arrives
 * and throughput leaves out the encoder's pauses. An MPD without these
 * plays as dash-cmaf and dash-live play it, so the stage replaces both in
 * a preset.
 *
 * Inert module: exports a factory, registers nothing at import time.
 */

import { completeChunks } from '../../containers/mp4-box/index.js';
import type { SliceReducer } from '../../types/kernel.js';
import type { Stage } from '../../types/stage.js';
import { RETRY_SECONDS } from '../adapter-shared.js';
import { createReduceDash, installDashPeriods, MANIFEST_TYPES } from '../dash-cmaf/index.js';
import { createReduceDashLive } from '../dash-live/index.js';
import { registerLiveNamespace } from '../live-shared.js';

export type { LiveApi } from '../live-shared.js';

export interface DashLlOptions {
  /**
   * Seconds before a segment index that failed or held no segment is tried
   * again; its rendition sits out meanwhile. Infinity keeps it out until the
   * next load. Defaults to 15.
   */
  readonly unavailableRetrySeconds?: number;
}

/** The stage factory. It provides `dash-cmaf` and `dash-live`, so stages that require either compose with it. */
export default function dashLl(options: DashLlOptions = {}): Stage {
  const retryMs = (options.unavailableRetrySeconds ?? RETRY_SECONDS) * 1000;
  return {
    name: 'dash-ll',
    provides: ['dash-ll', 'dash-cmaf', 'dash-live', ...MANIFEST_TYPES],
    install(ctx) {
      ctx.reduce('dash', createReduceDash(retryMs, true) as SliceReducer);
      ctx.reduce('dash-live', createReduceDashLive(true) as SliceReducer);
      ctx.registerChunkSplitter(completeChunks);
      registerLiveNamespace(ctx);
      return installDashPeriods(ctx);
    },
  };
}
