/**
 * Transcript: the cues of a text track, read apart from playback. The
 * kernel loads a text track's segments near the playhead and drops them
 * behind it, so the native track never holds a whole programme. A page
 * that lists every line, or searches them, asks here.
 *
 * The stage reads the track's segments itself, the ones that overlap the
 * range asked for, through the transport, so request hooks (auth, cmcd,
 * steering) apply. Each segment becomes cues the way the cue pipeline
 * makes them: the transforms, then the parser of the track's format. A
 * track that is not showing has no segment list in HLS until its playlist
 * loads; the stage asks the adapters for it, as a frame preview does for
 * the I-frame track.
 *
 * Nothing loads until `cues()` is called, and a segment read once is kept
 * until the next LOAD, UNLOAD, or DETACH. In-band captions (CEA-608,
 * CEA-708) are inside the video segments and have no segments of their
 * own: the stage does not list them.
 */

import { cueFormat } from '../../kernel/mime.js';
import { isIndexed, isUnresolved, segmentAt, segmentAtTime } from '../../kernel/timeline.js';
import type { Period, Rendition, Segment, SegmentRef, Track } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { CapabilityDescriptor, Stage } from '../../types/stage.js';

declare module '../../index.js' {
  interface MatteboxNamespaces {
    transcript: TranscriptApi;
  }
}

/** One line of a transcript: a cue's times and its text, with the format's own markup. */
export interface TranscriptCue {
  /** Start in presentation time, in seconds. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The part of a programme to read. Without a bound, that side runs to the programme's end. */
export interface TranscriptRange {
  /** Seconds, presentation time. Absent: from the start. */
  readonly start?: number;
  /** Seconds, presentation time. Absent: to the end. A live stream needs one. */
  readonly end?: number;
  /** Stops the requests still to send. The promise then rejects with an AbortError. */
  readonly signal?: AbortSignal;
}

export interface TranscriptApi {
  /**
   * The text tracks the stage can read: those with segments of their own,
   * in a format a stage of this engine parses. Track ids, in the
   * presentation's order.
   */
  readonly tracks: readonly string[];
  /**
   * The cues of a text track from every segment that overlaps `range`, by
   * start, each once. The whole programme without a range. Rejects for a
   * track the stage cannot read, when a segment fails to load, and when
   * another source loads meanwhile.
   */
  cues(trackId: string, range?: TranscriptRange): Promise<readonly TranscriptCue[]>;
}

/** Requests at once. Subtitle segments are small, and the stream's own requests come first. */
const PARALLEL = 4;
/** How long a track's segment list may take to arrive, in milliseconds. */
const RESOLVE_MS = 15_000;

interface TranscriptSlice {
  /** Moves on every LOAD, UNLOAD, and DETACH; what was read before no longer applies. */
  readonly loads: number;
}

const reduceTranscript: SliceReducer<TranscriptSlice> = (slice, msg) => {
  const state = slice ?? { loads: 0 };
  if (msg.type === 'LOAD' || msg.type === 'UNLOAD' || msg.type === 'DETACH') {
    return [{ loads: state.loads + 1 }, []];
  }
  return [state, []];
};

/** A text track in one period, with the rendition its segments come from. */
interface Site {
  readonly period: Period;
  readonly track: Track;
  readonly rendition: Rendition;
}

/** The track `trackId` in each period that has it. A text track has one rendition. */
function sitesOf(state: Readonly<KernelState>, trackId: string): Site[] {
  const sites: Site[] = [];
  for (const period of state.presentation?.periods ?? []) {
    const track = period.tracks.find((t) => t.id === trackId && t.contentType === 'text');
    const rendition = track?.renditions[0];
    if (track !== undefined && rendition !== undefined) sites.push({ period, track, rendition });
  }
  return sites;
}

/** Whether the rendition's segments are known: an HLS playlist loaded, a DASH index parsed. */
function resolved(rendition: Rendition): boolean {
  const addressing = rendition.segments;
  if (isUnresolved(addressing)) return false;
  return !Array.isArray(addressing) || addressing.length > 0;
}

/** The segments of `site` that overlap `[start, end)`. Throws for an open-ended list without an end. */
function segmentsIn(site: Site, start: number, end: number): Segment[] {
  const addressing = site.rendition.segments;
  if (!isIndexed(addressing)) {
    if (isUnresolved(addressing)) return [];
    return (addressing as readonly Segment[]).filter(
      (segment) => segment.start < end && segment.start + segment.duration > start,
    );
  }
  if (addressing.endSeq === null && !Number.isFinite(end)) {
    throw new RangeError('transcript: a live stream needs a range with an end');
  }
  const out: Segment[] = [];
  let segment = segmentAtTime(addressing, start, site.period.start);
  while (segment !== null && segment.start < end) {
    out.push(segment);
    segment = segmentAt(addressing, segment.seq + 1, site.period.start);
  }
  return out;
}

function aborted(): DOMException {
  return new DOMException('The transcript was not read to its end', 'AbortError');
}

export default function transcript(): Stage {
  return {
    name: 'transcript',
    provides: ['transcript'],
    requires: ['transport'],
    install(ctx) {
      ctx.reduce('transcript', reduceTranscript as SliceReducer);
      const loads = (): number =>
        (ctx.getState().transcript as TranscriptSlice | undefined)?.loads ?? 0;

      // What was read of the source loaded now, by rendition and segment.
      let held = { loads: -1, segments: new Map<string, Promise<readonly TranscriptCue[]>>() };
      let inits = new Map<string, Promise<void>>();
      const asked = new Set<string>();
      function kept(): Map<string, Promise<readonly TranscriptCue[]>> {
        if (held.loads !== loads()) {
          held = { loads: loads(), segments: new Map() };
          inits = new Map();
          asked.clear();
        }
        return held.segments;
      }

      let running = 0;
      const queue: Array<() => void> = [];
      /** Runs `job` when one of the request slots is free. */
      async function slot<T>(job: () => Promise<T>): Promise<T> {
        if (running >= PARALLEL) await new Promise<void>((free) => queue.push(free));
        running += 1;
        try {
          return await job();
        } finally {
          running -= 1;
          queue.shift()?.();
        }
      }

      async function fetchBytes(ref: SegmentRef, signal?: AbortSignal): Promise<Uint8Array> {
        const range = ref.byteRange;
        const response = await ctx.request(ref.url, {
          method: 'GET',
          ...(range === undefined
            ? {}
            : { headers: { Range: `bytes=${range.start}-${range.end}` } }),
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) throw new TypeError(`transcript ${ref.url}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }

      /** The cue format of a track, as the reducer names it on a segment's meta. */
      const formatOf = (site: Site): string =>
        cueFormat(site.track.mimeType, site.rendition.codecs);

      function metaOf(site: Site): Omit<SegmentMeta, 'seq' | 'start' | 'duration' | 'isInit'> {
        return {
          trackId: site.track.id,
          renditionId: site.rendition.id,
          contentType: 'text',
          format: formatOf(site),
        };
      }

      /** Shows the parser the init segment once: cues in fMP4 take their timescale from it. */
      function initOnce(site: Site, init: SegmentRef, signal?: AbortSignal): Promise<void> {
        const key = `${site.rendition.id}|${init.url}@${init.byteRange?.start ?? 0}`;
        const known = inits.get(key);
        if (known !== undefined) return known;
        const pending = slot(() => fetchBytes(init, signal)).then(async (bytes) => {
          await ctx.parseCues(bytes, {
            ...metaOf(site),
            seq: -1,
            start: 0,
            duration: 0,
            isInit: true,
          });
        });
        pending.catch(() => {
          if (inits.get(key) === pending) inits.delete(key);
        });
        inits.set(key, pending);
        return pending;
      }

      /** The cues of one segment, read once per source. A failed read is tried again at the next call. */
      function cuesOf(
        site: Site,
        segment: Segment,
        signal?: AbortSignal,
      ): Promise<readonly TranscriptCue[]> {
        const segments = kept();
        const key = `${site.rendition.id}|${segment.seq}|${segment.url}@${segment.byteRange?.start ?? 0}`;
        const known = segments.get(key);
        if (known !== undefined) return known;
        const pending = (async () => {
          const init = segment.init ?? site.rendition.init;
          if (init !== undefined) await initOnce(site, init, signal);
          const bytes = await slot(() => fetchBytes(segment, signal));
          const cues = await ctx.parseCues(bytes, {
            ...metaOf(site),
            seq: segment.seq,
            start: segment.start,
            duration: segment.duration,
            isInit: false,
            ...(segment.discontinuity === true ? { discontinuity: true } : {}),
          });
          const lines: TranscriptCue[] = [];
          for (const cue of cues) {
            if (cue.text === undefined || cue.text.trim() === '') continue;
            lines.push({ start: cue.start, end: cue.end, text: cue.text });
          }
          return lines;
        })();
        pending.catch(() => {
          if (segments.get(key) === pending) segments.delete(key);
        });
        segments.set(key, pending);
        return pending;
      }

      /**
       * The track's sites once every one has its segment list, asking the
       * adapters for the lists that are missing.
       */
      function settle(trackId: string, signal?: AbortSignal): Promise<Site[]> {
        return new Promise<Site[]>((resolve, reject) => {
          const at = loads();
          let off: () => void = () => undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = (): void => {
            off();
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
          };
          const abort = (): void => {
            stop();
            reject(aborted());
          };
          const check = (): void => {
            if (loads() !== at) {
              abort();
              return;
            }
            const sites = sitesOf(ctx.getState(), trackId);
            if (sites.length === 0) {
              stop();
              reject(new RangeError(`transcript: no text track '${trackId}'`));
              return;
            }
            const waiting = sites.filter((site) => !resolved(site.rendition));
            if (waiting.length === 0) {
              stop();
              resolve(sites);
              return;
            }
            kept();
            for (const { rendition } of waiting) {
              if (asked.has(rendition.id)) continue;
              asked.add(rendition.id);
              ctx.dispatch({ type: 'RESOLVE_RENDITION', renditionId: rendition.id });
            }
          };
          if (signal?.aborted === true) {
            abort();
            return;
          }
          signal?.addEventListener('abort', abort);
          off = ctx.on('presentation:changed', check);
          timer = setTimeout(() => {
            stop();
            reject(new TypeError(`transcript: the segments of '${trackId}' did not arrive`));
          }, RESOLVE_MS);
          check();
        });
      }

      /** Whether a stage of this engine parses the track's format. */
      function readable(track: Track): boolean {
        if (track.contentType !== 'text' || track.instreamId !== undefined) return false;
        const rendition = track.renditions[0];
        if (rendition === undefined) return false;
        const format = cueFormat(track.mimeType, rendition.codecs);
        return ctx.capabilities().some((capability) => {
          if (typeof capability === 'string') return false;
          const descriptor = capability as CapabilityDescriptor;
          return (
            descriptor.contentType === 'text' &&
            cueFormat(descriptor.mimeType, descriptor.codecs) === format
          );
        });
      }

      const api: TranscriptApi = {
        get tracks() {
          const ids: string[] = [];
          for (const period of ctx.getState().presentation?.periods ?? []) {
            for (const track of period.tracks) {
              if (readable(track) && !ids.includes(track.id)) ids.push(track.id);
            }
          }
          return ids;
        },
        async cues(trackId, range = {}) {
          const at = loads();
          const start = range.start ?? Number.NEGATIVE_INFINITY;
          const end = range.end ?? Number.POSITIVE_INFINITY;
          const sites = await settle(trackId, range.signal);
          const reads: Array<Promise<readonly TranscriptCue[]>> = [];
          for (const site of sites) {
            for (const segment of segmentsIn(site, start, end)) {
              reads.push(cuesOf(site, segment, range.signal));
            }
          }
          const parts = await Promise.all(reads);
          if (loads() !== at) throw aborted();
          // A cue that crosses a segment boundary is in both segments.
          const seen = new Set<string>();
          const lines: TranscriptCue[] = [];
          for (const part of parts) {
            for (const cue of part) {
              const key = `${cue.start}|${cue.end}|${cue.text}`;
              if (seen.has(key)) continue;
              seen.add(key);
              lines.push(cue);
            }
          }
          return lines.sort((a, b) => a.start - b.start || a.end - b.end);
        },
      };
      ctx.registerNamespace('transcript', api);
      return () => {
        held = { loads: -1, segments: new Map() };
        inits = new Map();
        asked.clear();
      };
    },
  };
}
