/**
 * A dry run of a load: a second message loop over the engine's own reducer
 * and slices, with no MediaSource. It makes the requests a load of the
 * same URL would make, through the engine's transport, and the transport
 * keeps every response for that load. `engine.preload` runs one to fetch
 * a source's playlists, init segments and first media segments ahead.
 *
 * The reducer and the slices are pure, so the dry run needs no protocol
 * code. It answers the buffer effects itself: a buffer opens at once, and
 * an append ends at once with the segment's own time as the buffered
 * range. Events never leave it, so the page hears nothing.
 *
 * It shares no state with the playing stream. The transform pipeline does
 * not run: a transmuxer or a decrypt step holds state for what plays. The
 * time probe runs under a rendition name of its own, so the timescales it
 * learns here never replace the playing stream's.
 */
import type { TimeRange } from '../types/ir.js';
import type { KernelConfig, SliceReducer } from '../types/kernel.js';
import type { Fact, LoadSeed, Message } from '../types/messages.js';
import { createBus } from './bus.js';
import type { HookRegistry } from './context.js';
import { createEffectRunner } from './effects.js';
import { createSegmentPreparer } from './prepare.js';
import { createReducer, initialState } from './reducer.js';
import type { Transport } from './transport.js';

export interface DryRunDeps {
  readonly slices: ReadonlyArray<readonly [string, SliceReducer]>;
  readonly config: Partial<KernelConfig>;
  readonly hooks: HookRegistry;
  readonly transport: Transport;
  readonly element: HTMLMediaElement;
  /** What the run starts from. The load of the same URL starts from it too. */
  readonly seed: LoadSeed;
}

export interface DryRunOptions {
  readonly mimeType?: string;
  /** The presentation time the load will start from: the segments come from there. */
  readonly start?: number;
  /** Media segments to fetch per track. */
  readonly segments: number;
  /** Milliseconds each response is kept. */
  readonly keepMs: number;
}

/** The whole run ends here, whatever it has fetched: a preload must not outlive its use. */
const LIMIT_MS = 10_000;
/** Ranges this close are one range, as a SourceBuffer reports them. */
const TOUCHING = 0.1;

function merge(ranges: readonly TimeRange[], added: TimeRange): TimeRange[] {
  const sorted = [...ranges, added].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && range.start <= last.end + TOUCHING) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      out.push(range);
    }
  }
  return out;
}

/**
 * Resolves when each media track has its segments, when the loop has
 * nothing left to fetch, or at the time limit. Rejects when the manifest
 * fails.
 */
export function dryRun(deps: DryRunDeps, url: string, options: DryRunOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const bus = createBus({
      reducer: createReducer(deps.slices, deps.config, deps.hooks),
      initial: initialState(deps.config),
      traceCapacity: 0,
    });
    const runner = createEffectRunner();
    bus.setEffectSink((effects) => runner.run(effects));

    let stopped = false;
    let failure: unknown = null;
    // A set, not a map by token: several loopbacks of one reduction share a token.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    /** Per buffer: the segments loaded and not yet appended, null for an init. */
    const loaded = new Map<string, Array<TimeRange | null>>();
    const ranges = new Map<string, TimeRange[]>();
    /** Media segments loaded, per buffer. */
    const counts = new Map<string, number>();
    /**
     * The requests still out, by token. The reducer's own record does not
     * hold a slice's requests, a media playlist among them.
     */
    const open = new Set<string>();

    const inflight = (token: string) => bus.getState().scheduling.inflight.get(token);

    function finish(error?: unknown): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(limit);
      for (const id of timers) clearTimeout(id);
      channel.close();
      if (error === undefined) resolve();
      else reject(error);
    }

    /** Whether the run has what it came for, or nothing left to do. */
    function check(): void {
      if (stopped) return;
      const state = bus.getState();
      if (state.lifecycle.phase === 'error') {
        finish(failure ?? new Error(`preload ${url} failed`));
        return;
      }
      if (state.presentation === null) return;
      const tracks = (['video', 'audio'] as const).filter((type) => state.tracks.active.has(type));
      const full =
        tracks.length > 0 &&
        tracks.every((type) => (counts.get(`sb:${type}`) ?? 0) >= options.segments);
      // A clip shorter than the count runs out of segments first.
      const idle = open.size === 0 && timers.size === 0;
      if (full || idle) finish();
    }

    /** A message from outside the loop: a response, a timer. The loop is at rest when it returns. */
    function feed(msg: Message): void {
      if (stopped) return;
      bus.route(msg);
      check();
    }

    const probe = deps.hooks.timeProbe;
    const prepare = createSegmentPreparer({
      transforms: () => [],
      timeProbe: () =>
        probe == null
          ? null
          : (data, meta) => probe(data, { ...meta, renditionId: `preload:${meta.renditionId}` }),
      inflight,
      absorb: (fact: Fact) => {
        if (stopped) return;
        if (fact.type === 'SEGMENT_LOADED' && fact.token !== undefined) {
          open.delete(fact.token);
          const request = inflight(fact.token);
          if (request?.sbId !== undefined) {
            const media = request.seq >= 0;
            const start = request.segmentStart ?? 0;
            const queue = loaded.get(request.sbId) ?? [];
            queue.push(media ? { start, end: start + (request.segmentDuration ?? 0) } : null);
            loaded.set(request.sbId, queue);
            if (media) counts.set(request.sbId, (counts.get(request.sbId) ?? 0) + 1);
          }
        }
        feed(fact);
      },
    });
    const channel = deps.transport.channel({
      absorb: prepare,
      inflight,
      keepMs: options.keepMs,
      failed: (token) => open.delete(token),
    });

    runner.register('fetch', (effect) => {
      if (stopped) return undefined;
      const request = inflight(effect.token);
      // A live edge moves before the load: its media would be the wrong segments.
      if (
        bus.getState().presentation?.isLive === true &&
        request?.sbId !== undefined &&
        request.seq >= 0
      ) {
        finish();
        return undefined;
      }
      // A track that has its segments asks for no more. Its request stays
      // open in the reducer, so the track waits while the others catch up.
      if (
        request?.sbId !== undefined &&
        request.seq >= 0 &&
        (counts.get(request.sbId) ?? 0) >= options.segments
      ) {
        return undefined;
      }
      open.add(effect.token);
      const cancel = channel.fetch(effect);
      // The runner calls this for the abort effect of the token.
      return () => {
        open.delete(effect.token);
        cancel();
      };
    });
    runner.register('schedule', (effect) => {
      if (stopped) return undefined;
      const id = setTimeout(() => {
        timers.delete(id);
        feed(
          effect.then.type === 'TICK'
            ? { ...effect.then, wallClock: Date.now() / 1000 }
            : effect.then,
        );
      }, effect.delayMs);
      timers.add(id);
      return () => {
        clearTimeout(id);
        timers.delete(id);
      };
    });
    // The answers below land inside the loop's own turn, so they do not
    // check: the loop is not at rest until that turn ends.
    runner.register('createSourceBuffer', (effect) => {
      bus.absorb({ type: 'SOURCEBUFFER_CREATED', sbId: effect.sbId, codecs: effect.codecs });
      return undefined;
    });
    runner.register('append', (effect) => {
      const segment = loaded.get(effect.sbId)?.shift();
      if (segment != null) ranges.set(effect.sbId, merge(ranges.get(effect.sbId) ?? [], segment));
      bus.absorb({
        type: 'SOURCEBUFFER_UPDATEEND',
        sbId: effect.sbId,
        ranges: ranges.get(effect.sbId) ?? [],
      });
      return undefined;
    });
    runner.register('emit', (effect) => {
      // Kept for the rejection, and never emitted: the page hears nothing of a dry run.
      const payload = effect.payload as { readonly fatal?: boolean } | null;
      if (effect.event === 'error' && payload?.fatal === true) failure = payload;
      return undefined;
    });

    const limit = setTimeout(finish, LIMIT_MS);
    bus.dispatch({ type: 'ATTACH', element: deps.element });
    feed({
      type: 'LOAD',
      url,
      seed: deps.seed,
      ...(options.mimeType !== undefined ? { mimeType: options.mimeType } : {}),
      ...(options.start !== undefined ? { start: options.start } : {}),
    });
  });
}
