/**
 * Low-latency HLS (RFC 8216bis): hls-cmaf and hls-live in one stage, with
 * a media playlist parser that reads the parts and the preload hint, and a
 * reload loop that uses blocking reloads, delta updates, and rendition
 * reports. A playlist without them plays as hls-cmaf and hls-live play it,
 * so the stage replaces both in a preset.
 *
 * Inert module: exports a factory, registers nothing at import time.
 */

import type { SliceReducer } from '../../types/kernel.js';
import type { Stage } from '../../types/stage.js';
import { RETRY_SECONDS } from '../adapter-shared.js';
import { createReduceHls, MANIFEST_TYPES } from '../hls-cmaf/index.js';
import { createReduceHlsLive } from '../hls-live/index.js';
import { registerLiveNamespace } from '../live-shared.js';
import { nextReload, parseLowLatency, reportsOf } from './parse.js';

export type { LiveApi } from '../live-shared.js';

export interface HlsLlOptions {
  /**
   * Seconds before a media playlist that failed is tried again; its
   * renditions sit out meanwhile. Infinity keeps them out until the next
   * load. Defaults to 15.
   */
  readonly unavailableRetrySeconds?: number;
}

/** The stage factory. It provides `hls-cmaf` and `hls-live`, so stages that require either compose with it. */
export default function hlsLl(options: HlsLlOptions = {}): Stage {
  const retryMs = (options.unavailableRetrySeconds ?? RETRY_SECONDS) * 1000;
  return {
    name: 'hls-ll',
    provides: ['hls-ll', 'hls-cmaf', 'hls-live', ...MANIFEST_TYPES],
    install(ctx) {
      ctx.reduce('hls', createReduceHls(retryMs, parseLowLatency) as SliceReducer);
      ctx.reduce(
        'hls-live',
        createReduceHlsLive(retryMs, {
          parse: parseLowLatency,
          next: nextReload,
          reports: reportsOf,
        }) as SliceReducer,
      );
      registerLiveNamespace(ctx);
    },
  };
}
