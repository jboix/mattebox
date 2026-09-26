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
import {
  decoderConfigBox,
  findBox,
  fragmentSamples,
  trackTimescales,
  trexDefaults,
} from '../../containers/mp4-box/index.js';
import { looksLikeTransportStream, programTables } from '../../containers/ts-transmux/demux.js';
import { findRendition, findTrackSite, isTrick } from '../../kernel/presentation.js';
import { isUnresolved, segmentAtTime } from '../../kernel/timeline.js';
import type { ByteRange, Segment, Track } from '../../types/ir.js';
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
  /** True between scrubStart and scrubEnd. */
  readonly scrubbing: boolean;
  /**
   * Starts scrubbing: the video switches to the I-frame track and pauses, so
   * scrubTo shows the key frame at each position. Throws an Error without an
   * I-frame track. A scan in progress hands over to the scrub.
   */
  scrubStart(): void;
  /**
   * Shows the key frame at `time`. Call it on every pointer move: the
   * browser drops a seek still in flight when a new one starts.
   */
  scrubTo(time: number): void;
  /**
   * Ends scrubbing at `time`, or where the scrub left the playhead: the
   * normal stream returns, and playback resumes if it was playing before.
   */
  scrubEnd(time?: number): void;
  /**
   * The key frame nearest before `time` from the I-frame track, decoded
   * with WebCodecs and scaled to `width` (default 320), for a preview.
   * Null without WebCodecs, without an I-frame track, on encrypted content,
   * on TS I-frames, while the track's segments are still being resolved,
   * and when a later call replaced this one while it waited. One frame
   * decodes at a time and only the newest waiting call is kept. The bitmap
   * belongs to a small cache: draw it, never close it.
   */
  frameAt(time: number, options?: { readonly width?: number }): Promise<ImageBitmap | null>;
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
/** While scrubbing only the frame under the pointer matters, not seconds ahead. */
const SCRUB_BUFFER_GOAL = 4;
/** Decoded preview frames kept, by segment and width. */
const FRAME_CACHE_SIZE = 24;
const DEFAULT_FRAME_WIDTH = 320;

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

/**
 * One key frame decoded with WebCodecs, or null when the browser cannot
 * configure the codec or produces no frame. The decoder lives for one frame.
 */
async function decodeKeyFrame(
  codec: string,
  description: Uint8Array,
  data: Uint8Array,
): Promise<VideoFrame | null> {
  let frame: VideoFrame | null = null;
  const decoder = new VideoDecoder({
    output: (out) => {
      if (frame === null) frame = out;
      else out.close();
    },
    error: () => undefined,
  });
  try {
    const support = await VideoDecoder.isConfigSupported({ codec, description });
    if (support.supported !== true) return null;
    decoder.configure({ codec, description });
    decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
    await decoder.flush();
    return frame;
  } catch {
    return null;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
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

      /** The normal stream, rate, mute, and play state from before scanning or scrubbing. */
      function restore(): void {
        const was = saved;
        saved = null;
        if (was === null) return;
        if (was.mainTrackId !== null) {
          ctx.dispatch({ type: 'SELECT_TRACK', trackId: was.mainTrackId, apply: 'now' });
        }
        ctx.dispatch({ type: 'SET_BUFFER_GOAL', seconds: was.bufferGoal });
        element.playbackRate = 1;
        element.muted = was.muted;
        if (was.playing) void element.play().catch(() => undefined);
      }

      /** Ends a scan. `resume` is false when a new source took over. */
      function end(reason: string, resume = true): void {
        stopTimer();
        const was = rate;
        rate = 1;
        if (saved === null) return;
        if (resume) restore();
        else saved = null;
        ctx.emit('trick:stopped', { rate: was, reason });
      }

      /** True when a new source loaded since scanning or scrubbing began; both just stop. */
      function stale(): boolean {
        if (saved === null || loads === currentLoads()) return false;
        scrubbing = false;
        end('load', false);
        return true;
      }

      // ---- scrubbing --------------------------------------------------
      let scrubbing = false;

      function clamp(time: number): number {
        const ranges = element.seekable;
        if (ranges.length === 0) return Math.max(0, time);
        return Math.min(Math.max(time, ranges.start(0)), ranges.end(ranges.length - 1));
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

      function scrubStart(): void {
        stale();
        if (trickTrack(ctx.getState()) === null) {
          throw new Error('this presentation has no I-frame track to scrub with');
        }
        if (scrubbing) return;
        if (saved !== null) {
          // A scan hands over: the trick track stays, the timer stops.
          stopTimer();
          ctx.emit('trick:stopped', { rate, reason: 'scrub' });
          rate = 1;
        } else {
          begin();
        }
        const was = saved;
        if (was === null) return;
        scrubbing = true;
        element.pause();
        element.playbackRate = 1;
        ctx.dispatch({
          type: 'SET_BUFFER_GOAL',
          seconds: Math.min(was.bufferGoal, SCRUB_BUFFER_GOAL),
        });
        ctx.emit('trick:scrub-started', {});
      }

      function scrubTo(time: number): void {
        if (stale() || !scrubbing || !Number.isFinite(time)) return;
        // The element, not the kernel: seeks this frequent must not abort the
        // small I-frame fetches in flight. The kernel follows the seeking event.
        element.currentTime = clamp(time);
      }

      function scrubEnd(time?: number): void {
        if (stale() || !scrubbing) return;
        scrubbing = false;
        const to = clamp(time ?? element.currentTime);
        // Through the kernel, so the switch back plans around this time and
        // not around the last seek the element reported.
        ctx.dispatch({ type: 'SEEK', to });
        restore();
        ctx.emit('trick:scrub-ended', { time: to });
      }

      // ---- frame previews ----------------------------------------------
      const frames = new Map<string, ImageBitmap>();
      const inits = new Map<string, Promise<Uint8Array | null>>();
      const resolving = new Set<string>();

      async function fetchBytes(url: string, range?: ByteRange): Promise<Uint8Array | null> {
        const headers: Record<string, string> =
          range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` };
        const response = await ctx.request(url, { headers });
        return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
      }

      /** The smallest I-frame rendition: a preview card needs no more. */
      function previewSite(state: Readonly<KernelState>) {
        const trick = trickTrack(state);
        if (trick === null || trick.protection !== null) return null;
        const smallest = [...trick.renditions].sort((a, b) => a.bitrate - b.bitrate)[0];
        return smallest === undefined ? null : findRendition(state.presentation, smallest.id);
      }

      /** The frame being decoded, and the newest call waiting behind it. */
      let working: Promise<unknown> | null = null;
      let waiting: {
        run: () => Promise<ImageBitmap | null>;
        settle: (b: ImageBitmap | null) => void;
      } | null = null;

      function frameAt(
        time: number,
        options: { readonly width?: number } = {},
      ): Promise<ImageBitmap | null> {
        const run = () => decodeFrameAt(time, options);
        if (working === null) return start(run);
        // Busy: this call replaces the one waiting; the running one finishes and is cached.
        waiting?.settle(null);
        return new Promise((settle) => {
          waiting = { run, settle };
        });
      }

      function start(run: () => Promise<ImageBitmap | null>): Promise<ImageBitmap | null> {
        const job = run().catch(() => null);
        working = job;
        void job.then(() => {
          working = null;
          const next = waiting;
          waiting = null;
          if (next !== null) void start(next.run).then(next.settle);
        });
        return job;
      }

      async function decodeFrameAt(
        time: number,
        options: { readonly width?: number },
      ): Promise<ImageBitmap | null> {
        if (typeof VideoDecoder === 'undefined' || !Number.isFinite(time)) return null;
        const state = ctx.getState();
        const site = previewSite(state);
        if (site === null) return null;
        const { rendition, period } = site;
        const addressing = rendition.segments;
        if (isUnresolved(addressing) || (Array.isArray(addressing) && addressing.length === 0)) {
          // Not playing, so not resolved: ask once; a later call finds the segments.
          if (!resolving.has(rendition.id)) {
            resolving.add(rendition.id);
            ctx.dispatch({ type: 'RESOLVE_RENDITION', renditionId: rendition.id });
          }
          return null;
        }
        const segment = segmentAtTime(addressing, time, period.start);
        if (segment === null || rendition.codecs === null || rendition.init === undefined) {
          return null;
        }
        const width = options.width ?? DEFAULT_FRAME_WIDTH;
        const key = `${segment.url}@${segment.byteRange?.start ?? 0}:${width}`;
        const cached = frames.get(key);
        if (cached !== undefined) {
          frames.delete(key);
          frames.set(key, cached);
          return cached;
        }
        const init = rendition.init;
        let initBytes = inits.get(rendition.id);
        if (initBytes === undefined) {
          initBytes = fetchBytes(init.url, init.byteRange).catch(() => null);
          inits.set(rendition.id, initBytes);
        }
        const [head, bytes] = await Promise.all([
          initBytes,
          fetchBytes(segment.url, segment.byteRange).catch(() => null),
        ]);
        if (head === null || bytes === null) return null;
        const config = decoderConfigBox(head);
        if (config === null || looksLikeTransportStream(bytes)) return null;
        const key0 = fragmentSamples(bytes, trexDefaults(head))[0]?.samples.find(
          (s) => s.isKeyframe && s.offset + s.size <= bytes.byteLength,
        );
        if (key0 === undefined) return null;
        const frame = await decodeKeyFrame(
          rendition.codecs,
          config.description,
          bytes.subarray(key0.offset, key0.offset + key0.size),
        );
        if (frame === null) return null;
        try {
          const bitmap = await createImageBitmap(frame, {
            resizeWidth: width,
            resizeQuality: 'medium',
          });
          frames.set(key, bitmap);
          if (frames.size > FRAME_CACHE_SIZE) {
            const [oldest, evicted] = frames.entries().next().value as [string, ImageBitmap];
            frames.delete(oldest);
            evicted.close();
          }
          return bitmap;
        } finally {
          frame.close();
        }
      }

      const api: TrickApi = {
        get available() {
          return trickTrack(ctx.getState()) !== null;
        },
        get rate() {
          stale();
          return rate;
        },
        get scrubbing() {
          stale();
          return scrubbing;
        },
        scrubStart,
        scrubTo,
        scrubEnd,
        frameAt,
        setRate(next: number): void {
          stale();
          // A scan replaces a scrub; what to restore stays the same.
          scrubbing = false;
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
        for (const bitmap of frames.values()) bitmap.close();
        frames.clear();
        element.removeEventListener('timeupdate', onTimeUpdate);
      };
    },
  };
}
