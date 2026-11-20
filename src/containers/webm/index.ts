/**
 * WebM segments in DASH. MSE takes `video/webm` and `audio/webm` as they
 * are (W3C WebM Byte Stream Format,
 * https://www.w3.org/TR/mse-byte-stream-format-webm/), so nothing is
 * rewrapped. The stage does two things:
 *
 * - It provides the `video/webm` and `audio/webm` content handlers, so the
 *   DASH adapters keep WebM Representations instead of leaving them out.
 * - It resolves a WebM `SegmentBase`: it fetches the initialization range
 *   and the Cues at `indexRange`, and turns them into one byte-range
 *   segment per Cluster, as Shaka Player and dash.js do.
 *
 * A `SegmentTemplate` WebM Representation needs no index and plays from
 * the MPD alone. Inert module: exports a factory, registers nothing at
 * import time.
 */
import { scheduled, tickAfter } from '../../kernel/effects.js';
import { findRendition } from '../../kernel/presentation.js';
import { activeRenditions } from '../../kernel/rendition-select.js';
import { isUnresolved } from '../../kernel/timeline.js';
import type { MatteboxError } from '../../types/error.js';
import type { Rendition, SegmentAddressing, SidxSegments } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { type CuePoint, cuesToSegments, readCues, readInit, type WebmInit } from './cues.js';

/** The fetch of a rendition's initialization range: `webm:init:<renditionId>`. */
const INIT_TOKEN = 'webm:init:';
/** The fetch of a rendition's Cues: `webm:cues:<renditionId>`. */
const CUES_TOKEN = 'webm:cues:';
/** A failed index's retry: `webm:retry:<renditionId>`. */
const RETRY_TOKEN = 'webm:retry:';
/** The constraint source that excludes renditions whose index failed. */
const UNAVAILABLE = 'webm:unavailable';
/** The default wait before a failed index is tried again, as the DASH adapter waits. */
const RETRY_SECONDS = 15;

/** Options of the `webm` stage. */
export interface WebmOptions {
  /**
   * Seconds before a WebM index that failed or held no segment is tried
   * again; its rendition sits out meanwhile. Infinity keeps it out until
   * the next load. Defaults to 15.
   */
  readonly unavailableRetrySeconds?: number;
}

/** The stage's state slice. Plain data, so a trace replays it. */
interface WebmSlice {
  /** Fetches in flight, token to renditionId. */
  readonly pending: Readonly<Record<string, string>>;
  /** Renditions asked for and not merged yet, so none is fetched twice. */
  readonly asked: Readonly<Record<string, true>>;
  /** Parsed initialization ranges waiting for their Cues. */
  readonly inits: Readonly<Record<string, WebmInit>>;
  /** Parsed Cues waiting for their initialization range. */
  readonly cues: Readonly<Record<string, readonly CuePoint[]>>;
  /** Renditions whose index failed. Not fetched again until their retry. */
  readonly failed: Readonly<Record<string, true>>;
  /** The selection last looked at, so the index choice runs only when it changes. */
  readonly seen: string;
}

/** The slice before any load. */
const INITIAL: WebmSlice = { pending: {}, asked: {}, inits: {}, cues: {}, failed: {}, seen: '' };

/** WebM `SegmentBase` addressing not resolved yet, or null for anything else. */
function asWebm(addressing: SegmentAddressing | undefined): SidxSegments | null {
  return addressing !== undefined && isUnresolved(addressing) && addressing.format === 'webm'
    ? addressing
    : null;
}

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  return scheduled('webm:loopback', message);
}

/** A copy of `record` without `key`. */
function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** The slice with every trace of one rendition's index gone, its in-flight tokens too. */
function forget(state: WebmSlice, renditionId: string): WebmSlice {
  const pending = { ...state.pending };
  delete pending[`${INIT_TOKEN}${renditionId}`];
  delete pending[`${CUES_TOKEN}${renditionId}`];
  return {
    ...state,
    pending,
    asked: without(state.asked, renditionId),
    inits: without(state.inits, renditionId),
    cues: without(state.cues, renditionId),
  };
}

/** The error a WebM index that cannot be read reports. */
function invalid(renditionId: string, reason: string): MatteboxError {
  return {
    category: 'media',
    code: 'MEDIA_CONTAINER_INVALID',
    fatal: false,
    recoverable: false,
    context: { renditionId, reason },
  };
}

/**
 * An index that failed to load or could not be read. The rendition is
 * excluded until its retry, as the DASH adapter does for a `sidx`. When
 * that leaves a media track with no rendition, the load fails.
 */
function unavailable(
  state: WebmSlice,
  kernel: Readonly<KernelState>,
  renditionId: string,
  error: MatteboxError,
  retryMs: number,
): [WebmSlice, Effect[]] {
  const failed: Record<string, true> = { ...state.failed, [renditionId]: true };
  const next = { ...forget(state, renditionId), failed };
  const effects: Effect[] = [
    {
      kind: 'emit',
      event: 'error',
      payload: {
        category: error.category,
        code: error.code,
        fatal: false,
        recoverable: false,
        renditionId,
      },
    },
  ];
  const track =
    kernel.presentation === null ? null : findRendition(kernel.presentation, renditionId)?.track;
  const media = track?.contentType === 'video' || track?.contentType === 'audio';
  if (track != null && media && track.renditions.every((r) => r.id in failed)) {
    return [
      next,
      [...effects, feed({ type: 'MANIFEST_FAILED', error: { ...error, fatal: true } })],
    ];
  }
  effects.push(
    feed({
      type: 'CONSTRAIN',
      source: UNAVAILABLE,
      constraint: { excludeIds: Object.keys(failed) },
    }),
  );
  if (Number.isFinite(retryMs)) effects.push(tickAfter(`${RETRY_TOKEN}${renditionId}`, retryMs));
  return [next, effects];
}

/** The retry of a failed index: the rendition returns to arbitration and is fetched when needed. */
function retry(state: WebmSlice, renditionId: string): [WebmSlice, Effect[]] {
  if (!(renditionId in state.failed)) return [state, []];
  const failed = without(state.failed, renditionId);
  return [
    { ...state, failed },
    [
      feed({
        type: 'CONSTRAIN',
        source: UNAVAILABLE,
        constraint: { excludeIds: Object.keys(failed) },
      }),
    ],
  ];
}

/**
 * One fetched part of an index. Once both parts of a rendition are read,
 * its segments go to the kernel as a PLAYLIST_REFRESHED, which merges them
 * as it merges a resolved `sidx`.
 */
function received(
  state: WebmSlice,
  kernel: Readonly<KernelState>,
  token: string,
  bytes: ArrayBuffer,
  retryMs: number,
): [WebmSlice, Effect[]] {
  const renditionId = state.pending[token] as string;
  let next: WebmSlice = { ...state, pending: without(state.pending, token) };
  const rendition =
    kernel.presentation === null ? null : findRendition(kernel.presentation, renditionId);
  const addressing = asWebm(rendition?.rendition.segments);
  const initRange = rendition?.rendition.init?.byteRange;
  // The rendition left the presentation (a reload replaced it): nothing to do.
  if (addressing === null || initRange === undefined) return [forget(next, renditionId), []];
  const data = new Uint8Array(bytes);
  if (token.startsWith(INIT_TOKEN)) {
    const init = readInit(data);
    if (init === null) {
      return unavailable(next, kernel, renditionId, invalid(renditionId, 'no WebM Info'), retryMs);
    }
    next = { ...next, inits: { ...next.inits, [renditionId]: init } };
  } else {
    const cues = readCues(data);
    if (cues === null) {
      return unavailable(next, kernel, renditionId, invalid(renditionId, 'no WebM Cues'), retryMs);
    }
    next = { ...next, cues: { ...next.cues, [renditionId]: cues } };
  }
  const init = next.inits[renditionId];
  const cues = next.cues[renditionId];
  if (init === undefined || cues === undefined) return [next, []];
  const segments = cuesToSegments(init, initRange, cues, addressing);
  if (segments.length === 0) {
    const reason = 'WebM Cues hold no segment';
    return unavailable(next, kernel, renditionId, invalid(renditionId, reason), retryMs);
  }
  // Stays asked until the merge lands.
  return [
    { ...next, inits: without(next.inits, renditionId), cues: without(next.cues, renditionId) },
    [
      feed({
        type: 'PLAYLIST_REFRESHED',
        trackId: renditionId,
        renditionId,
        mediaSequence: 0,
        segments,
      }),
    ],
  ];
}

/**
 * The renditions whose index the selection needs and this slice has not
 * asked for: the same set the DASH adapter resolves for a `sidx`, the
 * playing video rendition and its ladder neighbours, and every rendition
 * of the active audio and text tracks.
 */
function needed(state: WebmSlice, kernel: Readonly<KernelState>): readonly Rendition[] {
  const out: Rendition[] = [];
  const types = ['video', 'audio', 'text'] as const;
  for (const { rendition } of activeRenditions(kernel, types, kernel.quality.active)) {
    if (asWebm(rendition.segments) === null || rendition.init?.byteRange === undefined) continue;
    if (rendition.id in state.asked || rendition.id in state.failed) continue;
    out.push(rendition);
  }
  return out;
}

/** The slice reducer. Pure: it reads bytes from facts and answers with effects. */
export const createReduceWebm =
  (retryMs: number): SliceReducer<WebmSlice> =>
  (slice, msg, kernel) => {
    const state = slice ?? INITIAL;
    if (msg.type === 'LOAD' || msg.type === 'UNLOAD' || msg.type === 'DETACH') {
      return [INITIAL, []];
    }
    if (msg.type === 'TICK' && msg.token.startsWith(RETRY_TOKEN)) {
      return retry(state, msg.token.slice(RETRY_TOKEN.length));
    }
    // The merge landed: the rendition is resolved, or gone.
    if (msg.type === 'PLAYLIST_REFRESHED' && msg.renditionId !== undefined) {
      if (msg.renditionId in state.asked) return [forget(state, msg.renditionId), []];
    }
    if (msg.type === 'SEGMENT_LOADED' && msg.trackId in state.pending) {
      return received(state, kernel, msg.trackId, msg.bytes, retryMs);
    }
    if (msg.type === 'SEGMENT_FAILED' && msg.trackId in state.pending) {
      // The transport already retried under its policy.
      const renditionId = state.pending[msg.trackId] as string;
      return unavailable(state, kernel, renditionId, msg.error, retryMs);
    }

    // Look at the selection again when it changed, as the DASH adapter does.
    if (kernel.lifecycle.phase !== 'ready' || kernel.presentation === null) return [state, []];
    const key = `${kernel.quality.version}:${kernel.quality.active}`;
    if (key === state.seen && msg.type !== 'RESUME') return [state, []];
    const effects: Effect[] = [];
    const pending = { ...state.pending };
    const asked = { ...state.asked };
    for (const rendition of needed(state, kernel)) {
      const addressing = asWebm(rendition.segments) as SidxSegments;
      const init = rendition.init as NonNullable<Rendition['init']>;
      asked[rendition.id] = true;
      // Both ranges at once: the Cues need the Info's scale and the
      // Segment's start, which only the initialization range holds.
      for (const [prefix, url, range] of [
        [INIT_TOKEN, init.url, init.byteRange],
        [CUES_TOKEN, addressing.url, addressing.indexRange],
      ] as const) {
        const token = `${prefix}${rendition.id}`;
        pending[token] = rendition.id;
        // The rendition rides along so a failure counts toward steering failover.
        effects.push({
          kind: 'fetch',
          token,
          url,
          ...(range !== undefined ? { range } : {}),
          renditionId: rendition.id,
        });
      }
    }
    return [{ ...state, pending, asked, seen: key }, effects];
  };

/**
 * The stage factory. Add it beside a DASH adapter:
 * `mattebox({ stages: [dashCmaf(), webm()] })`.
 */
export default function webm(options: WebmOptions = {}): Stage {
  const retryMs = (options.unavailableRetrySeconds ?? RETRY_SECONDS) * 1000;
  return {
    name: 'webm',
    provides: [
      'webm',
      { contentType: 'video', mimeType: 'video/webm' },
      { contentType: 'audio', mimeType: 'audio/webm' },
    ],
    requires: ['dash-cmaf'],
    install(ctx) {
      ctx.reduce('webm', createReduceWebm(retryMs) as SliceReducer);
    },
  };
}
