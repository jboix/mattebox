/**
 * Trick play: fast forward and rewind through the presentation's I-frame
 * track (an HLS I-frame playlist or a DASH trick-mode AdaptationSet),
 * answered through `engine.trick`.
 *
 * A full stream cannot decode at 8x, and MSE cannot play backwards. A scan
 * switches the video track to the trick track, where every frame decodes on
 * its own: forward plays it at the rate, rewind pauses and steps back on a
 * timer. Rate 1 switches back. Audio stays selected, muted, so its buffer
 * keeps pace and the switch back is seamless.
 *
 * Scanning is not playback speed. A rate up to 2x in either direction is
 * the element's own `playbackRate`, which the app sets on the video; this
 * stage refuses it, and refuses to scan without an I-frame track.
 *
 * A transform fits each trick fragment to its slot in the playlist
 * (fitFragment), because an I-frame lasts one frame period and the buffer
 * would otherwise hold islands a fast rate stalls in. Another gives a TS
 * I-frame range the program tables it starts past.
 */
import { fitFragment } from '../../containers/fmp4/fit.js';
import { concat } from '../../containers/fmp4/writer.js';
import type { SampleDefaults } from '../../containers/mp4-box/index.js';
import { findBox, trackTimescales, trexDefaults } from '../../containers/mp4-box/index.js';
import { looksLikeTransportStream, programTables } from '../../containers/ts-transmux/demux.js';
import { findRendition, findTrackSite, isTrick } from '../../kernel/presentation.js';
import type { Segment, Track } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

declare module '../../index.js' {
  interface MatteboxNamespaces {
    trick: TrickApi;
  }
}

export interface TrickApi {
  /** True when the presentation has an I-frame track to scan with. */
  readonly available: boolean;
  /** The rate in force: 1 for normal playback, above 2 forward, below -2 rewinding. */
  readonly rate: number;
  /**
   * Scans at `rate` through the I-frame track: above 2 forward, below -2
   * backward. 1 returns to normal playback. Throws a RangeError for any
   * other rate (set the element's `playbackRate` for those) and an Error
   * without an I-frame track.
   */
  setRate(rate: number): void;
}

/** A scan is faster than this, in either direction; slower is playback speed. */
const SCAN_THRESHOLD = 2;
/** Rewind steps back this often, by the rate times this interval. */
const REWIND_STEP_MS = 250;
/** After ts-transmux (100): a transmuxed TS I-frame is fitted too. */
const FIT_ORDER = 150;
/** Before ts-transmux (100): a TS I-frame range gets its program tables first. */
const TABLES_ORDER = 90;
/** The PAT and PMT sit in the first packets of a file; this much covers them. */
const TABLES_BYTES = 188 * 8;
/** Forward scanning stops this close to the live edge. */
const EDGE_MARGIN = 2;

interface TrickSlice {
  /** Moves on every LOAD, UNLOAD, and DETACH; scanning never outlives its source. */
  readonly loads: number;
}

const reduceTrick: SliceReducer<TrickSlice> = (slice, msg) => {
  const state = slice ?? { loads: 0 };
  if (msg.type === 'LOAD' || msg.type === 'UNLOAD' || msg.type === 'DETACH') {
    return [{ loads: state.loads + 1 }, []];
  }
  return [state, []];
};

function trickTrack(state: Readonly<KernelState>): Track | null {
  for (const period of state.presentation?.periods ?? []) {
    const track = period.tracks.find(isTrick);
    if (track !== undefined) return track;
  }
  return null;
}

export default function trickPlay(): Stage {
  return {
    name: 'trick-play',
    provides: ['trick-play', 'media-transform'],
    requires: ['scheduler', 'mse'],
    install(ctx) {
      ctx.reduce('trick-play', reduceTrick as SliceReducer);
      const element = ctx.element;

      // ---- program tables for TS I-frame ranges -------------------------
      // An HLS I-frame range in a transport stream starts at the frame, past
      // the PAT and PMT that name its streams. The start of the same file
      // holds them; each file's are fetched once.
      const tables = new Map<string, Promise<Uint8Array | null>>();
      function tablesOf(url: string, before: number): Promise<Uint8Array | null> {
        const known = tables.get(url);
        if (known !== undefined) return known;
        const end = Math.min(before, TABLES_BYTES) - 1;
        const pending = ctx
          .request(url, { headers: { Range: `bytes=0-${end}` } })
          .then(async (response) =>
            response.ok ? programTables(new Uint8Array(await response.arrayBuffer())) : null,
          )
          .catch(() => null);
        tables.set(url, pending);
        return pending;
      }
      ctx.registerTransform({
        name: 'trick-play-tables',
        order: TABLES_ORDER,
        async transform(data: Uint8Array, meta: SegmentMeta): Promise<Uint8Array> {
          if (meta.contentType !== 'video' || meta.isInit || !looksLikeTransportStream(data)) {
            return data;
          }
          const site = findRendition(ctx.getState().presentation, meta.renditionId);
          if (site === null || !isTrick(site.track) || programTables(data) !== null) return data;
          const segments = site.rendition.segments;
          const segment = Array.isArray(segments)
            ? (segments as readonly Segment[]).find((s) => s.seq === meta.seq)
            : undefined;
          const start = segment?.byteRange?.start ?? 0;
          if (segment === undefined || start === 0) return data;
          const found = await tablesOf(segment.url, start);
          return found === null ? data : concat(found, data);
        },
      });

      // ---- fitting trick fragments -------------------------------------
      const clocks = new Map<
        string,
        { timescale: number; defaults: ReadonlyMap<number, SampleDefaults> }
      >();
      ctx.registerTransform({
        name: 'trick-play',
        order: FIT_ORDER,
        transform(data: Uint8Array, meta: SegmentMeta): Uint8Array {
          if (meta.contentType !== 'video') return data;
          const site = findTrackSite(ctx.getState().presentation, meta.trackId);
          if (site === null || !isTrick(site.track)) return data;
          // An init segment, or a transmuxed segment carrying its own, names the clock.
          if (findBox(data, 'moov') !== null) {
            const timescale = [...trackTimescales(data).values()][0];
            if (timescale !== undefined) {
              clocks.set(meta.renditionId, { timescale, defaults: trexDefaults(data) });
            }
          }
          const moof = findBox(data, 'moof');
          const clock = clocks.get(meta.renditionId);
          if (meta.isInit || moof === null || clock === undefined) return data;
          const fitted = fitFragment(data, clock.timescale, meta.duration, clock.defaults);
          if (fitted === null) return data;
          // Anything before the fragment (a transmuxed segment's own init) stays.
          return moof.start === 0 ? fitted : concat(data.subarray(0, moof.start), fitted);
        },
      });

      // ---- scanning ---------------------------------------------------
      let rate = 1;
      let loads = 0;
      /** What scanning changed, to put back when it ends. */
      let saved: {
        mainTrackId: string | null;
        bufferGoal: number;
        muted: boolean;
        playing: boolean;
      } | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;

      const currentLoads = (): number =>
        (ctx.getState()['trick-play'] as TrickSlice | undefined)?.loads ?? 0;

      function stopTimer(): void {
        if (timer !== null) clearInterval(timer);
        timer = null;
      }

      /** Starts scanning from normal playback: remember what to restore, switch tracks. */
      function begin(): void {
        if (saved !== null) return;
        const state = ctx.getState();
        const trick = trickTrack(state) as Track;
        saved = {
          mainTrackId: state.tracks.active.get('video') ?? null,
          bufferGoal: state.scheduling.bufferGoal,
          muted: element.muted,
          playing: !element.paused,
        };
        loads = currentLoads();
        element.muted = true;
        ctx.dispatch({ type: 'SELECT_TRACK', trackId: trick.id, apply: 'now' });
      }

      /** Back to normal playback. `resume` is false when a new source took over. */
      function end(reason: string, resume = true): void {
        stopTimer();
        const restore = saved;
        saved = null;
        const was = rate;
        rate = 1;
        if (restore === null) return;
        if (resume) {
          if (restore.mainTrackId !== null) {
            ctx.dispatch({ type: 'SELECT_TRACK', trackId: restore.mainTrackId, apply: 'now' });
          }
          ctx.dispatch({ type: 'SET_BUFFER_GOAL', seconds: restore.bufferGoal });
          element.playbackRate = 1;
          element.muted = restore.muted;
          if (restore.playing) void element.play().catch(() => undefined);
        }
        ctx.emit('trick:stopped', { rate: was, reason });
      }

      /** True when a new source loaded since scanning began; scanning then just stops. */
      function stale(): boolean {
        if (saved === null || loads === currentLoads()) return false;
        end('load', false);
        return true;
      }

      function rewindStep(): void {
        if (stale()) return;
        const floor = element.seekable.length > 0 ? element.seekable.start(0) : 0;
        const to = element.currentTime + rate * (REWIND_STEP_MS / 1000);
        if (to <= floor) {
          element.currentTime = floor;
          end('start');
          return;
        }
        element.currentTime = to;
      }

      const onTimeUpdate = (): void => {
        if (rate <= SCAN_THRESHOLD || stale()) return;
        const live = ctx.getState().live;
        if (live !== null && element.currentTime >= live.edge - EDGE_MARGIN) end('edge');
      };
      element.addEventListener('timeupdate', onTimeUpdate);

      const api: TrickApi = {
        get available() {
          return trickTrack(ctx.getState()) !== null;
        },
        get rate() {
          stale();
          return rate;
        },
        setRate(next: number): void {
          stale();
          if (next === 1) {
            if (rate !== 1) end('rate');
            return;
          }
          if (!(Math.abs(next) > SCAN_THRESHOLD) || !Number.isFinite(next)) {
            throw new RangeError(
              `scan rate must be 1, above ${SCAN_THRESHOLD}, or below -${SCAN_THRESHOLD}, got ${next}; set the element's playbackRate for playback speed`,
            );
          }
          if (trickTrack(ctx.getState()) === null) {
            throw new Error('this presentation has no I-frame track to scan with');
          }
          const was = rate;
          begin();
          const restore = saved;
          if (restore === null) return;
          rate = next;
          stopTimer();
          // The buffer goal is in media seconds, and a scan uses them `rate` times faster.
          ctx.dispatch({
            type: 'SET_BUFFER_GOAL',
            seconds: restore.bufferGoal * Math.abs(next),
          });
          if (next > 0) {
            element.playbackRate = next;
            void element.play().catch(() => undefined);
          } else {
            element.pause();
            element.playbackRate = 1;
            timer = setInterval(rewindStep, REWIND_STEP_MS);
          }
          if (was === 1) ctx.emit('trick:started', { rate: next });
        },
      };
      ctx.registerNamespace('trick', api);

      return () => {
        stopTimer();
        element.removeEventListener('timeupdate', onTimeUpdate);
      };
    },
  };
}
