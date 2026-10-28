/**
 * Plays breaks: HLS interstitials, DASH alternative MPD events, and the
 * breaks a page schedules, on the one engine that plays the presentation.
 * At a break the engine loads the asset in the presentation's place, and
 * after it loads the presentation again at the resume point, each preloaded
 * ahead so the switch fetches nothing. hls.js and Shaka play an asset this
 * way when they cannot append it in place.
 *
 * SCTE-35 cue-outs are breaks with no assets: the presentation plays
 * through them, and the stage reports their start, quartiles and end, so a
 * player shows them as ads. A page fills one by scheduling assets under its
 * id before it starts.
 *
 * The rules follow Appendix D of draft-pantos-hls-rfc8216bis as hls.js
 * applies them: a pre-roll before the first frame, a post-roll at the end,
 * a `once` break plays once, a seek past `noJump` breaks plays the last of
 * them first, a `noSkip` break takes no seek, and a failed asset is skipped.
 *
 * The page reads `engine.interstitials` and listens to its events. The
 * element's `currentTime` stays the browser's: during a break it is the
 * asset's, and `primary` gives the presentation's.
 */
import { placeEmsg } from '../../containers/emsg.js';
import { findBox, trackTimescales } from '../../containers/mp4-box/index.js';
import { bytesToBase64 } from '../../kernel/base64.js';
import type { EventElement, Presentation } from '../../types/ir.js';
import type { Stage } from '../../types/stage.js';
import { assetsOf, type Break, type BreakAsset, breaksOf, fromEvent } from './breaks.js';

export type { AdCreative, Break, BreakAsset, BreakTracking, SpanRole } from './breaks.js';

/** A break the page gives: the assets to play at a time. */
export interface PageBreak {
  /** An opportunity's id fills that opportunity. Omitted: a new id. */
  readonly id?: string;
  readonly start: number;
  readonly cue?: 'pre' | 'post';
  readonly assets: readonly BreakAsset[];
  /** Seconds of the presentation the break replaces. 0, the default, inserts. */
  readonly covers?: number;
  readonly resumeOffset?: number;
  readonly once?: boolean;
  readonly noSkip?: boolean;
  readonly noJump?: boolean;
  readonly skipAfter?: number;
}

/** A playhead on one timeline. */
export interface Playhead {
  readonly currentTime: number;
  readonly duration: number;
  /** Seeks on this timeline, under the break rules. */
  seek(time: number): void;
}

export interface InterstitialsApi {
  /** Every break, by start. */
  readonly breaks: readonly Break[];
  /** The break that plays and the index of its asset, or null. */
  readonly playing: { readonly break: Break; readonly asset: number } | null;
  /** The presentation's playhead. During a break, where it stopped. */
  readonly primary: Playhead;
  /** The presentation with the inserted breaks counted in, as a seek bar shows it. */
  readonly integrated: Playhead;
  /** Adds a break, or fills an opportunity under its id. */
  schedule(entry: PageBreak): Break;
  /** Removes a break that has not started. */
  cancel(id: string): void;
  /** Ends the asset that plays, when the break allows it. */
  skip(): boolean;
  /**
   * The presentation and its post-rolls are over. A playlist moves on at
   * `interstitials:ended`, not at the element's `ended`, which comes before
   * the post-roll.
   */
  readonly ended: boolean;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    interstitials: InterstitialsApi;
  }
}

/** Seconds ahead of a break at which its asset list is fetched and its first asset preloaded (hls.js's live look-ahead). */
const LOOKAHEAD = 10;
/** Segments preloaded per track before a switch: with 3, the reels page started in under 50 ms. */
const SEGMENTS = 3;
/** A jump of the playhead larger than this, outside a seek event, counts as a seek. */
const JUMP = 2;
const QUARTILES = [0.25, 0.5, 0.75] as const;

interface Entry {
  break: Break;
  /** The asset list fetch, once started. */
  resolving?: Promise<void>;
  preloaded?: boolean;
  /** For a break without assets: inside it now. */
  inside?: boolean;
  quartiles?: number;
}

interface Playing {
  readonly entry: Entry;
  asset: number;
  /** Where the presentation resumes. */
  resume: number;
  /** A post-roll: the presentation comes back at its end, paused, and is over. */
  readonly ending: boolean;
  /** The presentation's time at the start of the break. */
  readonly at: number;
  quartiles: number;
  /** The asset's last time, which a refused seek goes back to. */
  last: number;
  limit: ReturnType<typeof setTimeout> | null;
}

/**
 * Whether a span is a break: an ad or a promotion. The credits and the
 * chapters a SCTE-35 section names are spans of the presentation, which a
 * player shows as such, never as an ad.
 */
function isBreak(entry: Break): boolean {
  return entry.role === undefined || entry.role === 'ad' || entry.role === 'promo';
}

/** How long a break plays, when known: its assets, its limit, or the span it covers. */
function lengthOf(entry: Break): number {
  const assets = entry.assets.reduce((sum, asset) => sum + (asset.duration ?? 0), 0);
  const known = assets > 0 ? assets : entry.covers;
  return entry.playoutLimit !== undefined ? Math.min(known, entry.playoutLimit) : known;
}

/**
 * The elements of an alternative MPD event an emsg carries as its message
 * data: the `InsertPresentation` or `ReplacePresentation` element, alone or
 * inside an `Event`. Empty for any other body.
 */
function presentationElements(data: Uint8Array): EventElement[] {
  const text = new TextDecoder().decode(data).trim();
  if (!text.startsWith('<') || typeof DOMParser === 'undefined') return [];
  const root = new DOMParser().parseFromString(text, 'application/xml').documentElement;
  if (root === null) return [];
  const found = /Presentation$|^AlternativeMPD$/.test(root.localName)
    ? [root]
    : Array.from(root.children).filter((e) => /Presentation$|^AlternativeMPD$/.test(e.localName));
  return found.map((e) => ({
    name: e.localName,
    attributes: Object.fromEntries(Array.from(e.attributes, (a) => [a.localName, a.value])),
  }));
}

export default function interstitials(): Stage {
  /**
   * What a detach leaves of the presentation: its URL, the breaks played,
   * the asset lists fetched. A player that plays a progressive ad on the
   * video detaches the engine, then loads the presentation again from where
   * it stopped; that load takes them back, so no break plays twice.
   */
  let memory: {
    readonly url: string;
    readonly played: readonly string[];
    readonly resolved: ReadonlyMap<string, readonly BreakAsset[]>;
  } | null = null;
  return {
    name: 'interstitials',
    provides: ['interstitials'],
    install(ctx) {
      const element = ctx.element;
      const entries = new Map<string, Entry>();
      /** The breaks played, by id: a rebuild of the schedule keeps them. */
      const played = new Set<string>();
      /** The assets each fetched asset list named, by break id. */
      const resolved = new Map<string, readonly BreakAsset[]>();
      const page = new Map<string, Break>();
      const told = new Set<string>();
      let primary: { url: string; mimeType?: string; start: number } | null = null;
      let presentationId: string | null = null;
      let duration = Number.NaN;
      let live = false;
      let own = false;
      let playing: Playing | null = null;
      /** A return in progress: the presentation's own seek to the resume point is no viewer seek. */
      let settling = false;
      let started = false;
      let ended = false;
      let lastTime = 0;
      let seekFrom: number | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let tracks: ReadonlyMap<string, string> | null = null;
      let seq = 0;
      /** A break waits for its asset list: no other starts meanwhile. */
      let pending = false;
      /** Whether the viewer wants playback: the element pauses at each load and at an asset's end. */
      let wanted = !element.paused;
      let switching = false;
      /** The presentation and its post-rolls are over. */
      let over = false;
      /** A live return: the break's id and the seconds from its start where the broadcast resumes. */
      let liveResume: { readonly id: string; readonly offset: number } | null = null;
      /** Breaks the media carries in emsg, by id. */
      const inband = new Map<string, Break>();
      const timescales = new Map<string, ReadonlyMap<number, number>>();

      const sorted = (): Entry[] =>
        [...entries.values()].sort((a, b) => a.break.start - b.break.start);
      const emit = (event: string, entry: Entry, extra: object = {}): void =>
        ctx.emit(`interstitials:${event}`, { id: entry.break.id, break: entry.break, ...extra });

      function reset(): void {
        if (playing?.limit != null) clearTimeout(playing.limit);
        entries.clear();
        played.clear();
        resolved.clear();
        page.clear();
        told.clear();
        playing = null;
        presentationId = null;
        started = false;
        ended = false;
        over = false;
        liveResume = null;
        inband.clear();
        timescales.clear();
        settling = false;
        lastTime = 0;
        tracks = null;
      }

      /**
       * The segment boundaries of the presentation's video, or its audio,
       * for X-SNAP. HLS only, where the segments are a list.
       */
      function edges(presentation: Presentation | null): number[] {
        const active = ctx.getState().tracks.active;
        const id = active.get('video') ?? active.get('audio');
        for (const period of presentation?.periods ?? []) {
          for (const track of period.tracks) {
            if (track.id !== id) continue;
            const segments = track.renditions[0]?.segments;
            if (!Array.isArray(segments)) return [];
            return (segments as readonly { start: number; duration: number }[]).map((s) => s.start);
          }
        }
        return [];
      }

      /** Where a break starts: at the segment boundary before it with X-SNAP=OUT. */
      function startOf(entry: Break): number {
        if (entry.snap?.out !== true) return entry.start;
        const before = edges(ctx.getState().presentation).filter((t) => t <= entry.start + 0.001);
        return before.length > 0 ? (before[before.length - 1] as number) : entry.start;
      }

      /** Where the presentation resumes: at the segment boundary after it with X-SNAP=IN. */
      function resumeOf(entry: Break, at: number): number {
        if (entry.snap?.in !== true) return at;
        return edges(ctx.getState().presentation).find((t) => t >= at - 0.001) ?? at;
      }

      /** Rebuilds the schedule from the presentation. */
      function refresh(): void {
        if (playing !== null || primary === null) return;
        const presentation = ctx.getState().presentation;
        if (presentation === null) return;
        presentationId = presentation.id;
        live = presentation.isLive;
        if (presentation.duration !== undefined) duration = presentation.duration;
        const fresh = [
          ...breaksOf(presentation, primary.url),
          ...inband.values(),
          ...page.values(),
        ];
        let changed = fresh.length !== entries.size;
        const ids = new Set<string>();
        for (const next of fresh) {
          ids.add(next.id);
          const known = entries.get(next.id);
          // A page break under an opportunity's id fills it.
          const filled = page.get(next.id);
          const signalled = filled !== undefined && next.source === 'scte35' ? filled : next;
          // An asset list already fetched keeps its assets.
          const assets = resolved.get(next.id);
          const value =
            assets !== undefined &&
            signalled.assets.length === 0 &&
            signalled.assetList !== undefined
              ? { ...signalled, assets }
              : signalled;
          if (known === undefined) {
            entries.set(next.id, { break: value });
            changed = true;
          } else if (JSON.stringify(known.break) !== JSON.stringify(value)) {
            known.break = value;
            changed = true;
          }
        }
        for (const id of [...entries.keys()]) if (!ids.has(id)) entries.delete(id);
        if (changed) ctx.emit('interstitials:changed', { breaks: api.breaks });
        for (const entry of entries.values()) {
          if (
            entry.break.source === 'scte35' &&
            isBreak(entry.break) &&
            !told.has(entry.break.id)
          ) {
            told.add(entry.break.id);
            emit('opportunity', entry, { duration: entry.break.covers });
          }
        }
        seekLive();
        // A pre-roll plays before the first frame, from wherever the load starts.
        if (!started) {
          const pre = sorted().find((e) => e.break.cue === 'pre' && !played.has(e.break.id));
          if (pre !== undefined) void begin(pre, primary.start);
        }
      }

      /**
       * After a live break, the broadcast resumes where the break said: the
       * same break in the reloaded presentation gives its start on the new
       * timeline, since an HLS live reload restarts the presentation clock.
       * Outside the window, the live edge stays.
       */
      function seekLive(): void {
        const target = liveResume;
        const window = ctx.getState().live;
        if (target === null || window === null) return;
        const entry = entries.get(target.id);
        if (entry === undefined) return;
        liveResume = null;
        const at = entry.break.start + target.offset;
        if (at < window.span.start || at > window.edge) return;
        settling = true;
        lastTime = at;
        element.currentTime = at;
      }

      /** Fetches the asset list of a break, once. A failure leaves it with no assets. */
      function resolve(entry: Entry): Promise<void> {
        const list = entry.break.assetList;
        if (list === undefined || entry.break.assets.length > 0) return Promise.resolve();
        entry.resolving ??= ctx
          .request(list, { method: 'GET' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const assets = assetsOf(await response.text(), response.url || list);
            resolved.set(entry.break.id, assets);
            entry.break = { ...entry.break, assets };
            ctx.emit('interstitials:changed', { breaks: api.breaks });
          })
          .catch((error: unknown) => {
            ctx.emit('interstitials:warning', {
              id: entry.break.id,
              url: list,
              reason: `asset list: ${String((error as Error).message ?? error)}`,
            });
          });
        return entry.resolving;
      }

      /** Loads in the presentation's place, playing on when the viewer was playing. */
      function load(url: string, options: { mimeType?: string; start?: number }): void {
        // Read before the load: the element pauses when its source changes.
        const resume = wanted || (!element.paused && !element.ended);
        own = true;
        switching = true;
        ctx.load(url, options);
        own = false;
        if (resume) keepPlaying();
      }

      function preload(url: string, options: { mimeType?: string; start?: number }): void {
        ctx.preload(url, { ...options, segments: SEGMENTS }).catch(() => {
          // The load reports what fails; a preload only saves time.
        });
      }

      /** Plays the new source once it can. */
      function keepPlaying(): void {
        wanted = true;
        const play = (): void => {
          void element.play()?.catch(() => {});
        };
        element.addEventListener('canplay', play, { once: true });
        play();
      }

      async function begin(
        entry: Entry,
        resume: number,
        at = element.currentTime,
        ending = false,
      ): Promise<void> {
        if (playing !== null || pending) return;
        played.add(entry.break.id);
        pending = true;
        await resolve(entry);
        pending = false;
        if (entry.break.assets.length === 0 || primary === null || playing !== null) return;
        const active = ctx.getState().tracks.active;
        tracks = new Map([...active].filter(([type]) => type === 'audio' || type === 'text'));
        playing = {
          entry,
          asset: -1,
          resume: ending ? resume : resumeOf(entry.break, resume),
          ending,
          at,
          quartiles: 0,
          last: 0,
          limit: null,
        };
        if (entry.break.playoutLimit !== undefined) {
          const current = playing;
          current.limit = setTimeout(() => {
            if (playing === current) finish();
          }, entry.break.playoutLimit * 1000);
        }
        emit('break-start', entry);
        next();
      }

      /** The next asset of the break, or the return to the presentation. */
      function next(): void {
        const current = playing;
        if (current === null) return;
        if (current.asset >= 0) {
          emit('asset-end', current.entry, { asset: current.asset });
        }
        current.asset += 1;
        current.quartiles = 0;
        current.last = 0;
        const asset = current.entry.break.assets[current.asset];
        if (asset === undefined) {
          finish();
          return;
        }
        load(asset.url, asset.mimeType !== undefined ? { mimeType: asset.mimeType } : {});
        emit('asset-start', current.entry, { asset: current.asset, url: asset.url });
        // Whatever comes after this asset starts without a request.
        const after = current.entry.break.assets[current.asset + 1];
        if (after !== undefined)
          preload(after.url, after.mimeType !== undefined ? { mimeType: after.mimeType } : {});
        else if (primary !== null) preload(primary.url, returnOptions(current.resume));
      }

      function returnOptions(resume: number): { mimeType?: string; start?: number } {
        return {
          ...(primary?.mimeType !== undefined ? { mimeType: primary.mimeType } : {}),
          // Live returns to the edge, where the break replaced the broadcast.
          ...(live ? {} : { start: resume }),
        };
      }

      function finish(): void {
        const current = playing;
        if (current === null || primary === null) return;
        if (current.limit !== null) clearTimeout(current.limit);
        if (current.asset >= 0 && current.asset < current.entry.break.assets.length) {
          emit('asset-end', current.entry, { asset: current.asset });
        }
        playing = null;
        emit('break-end', current.entry, { resume: current.resume });
        settling = true;
        lastTime = current.resume;
        if (current.ending) {
          // Back on the presentation's last frame, paused: it is over.
          wanted = false;
          load(primary.url, { ...returnOptions(current.resume), start: current.resume });
          over = true;
          ctx.emit('interstitials:ended', {});
          return;
        }
        if (live) {
          liveResume = {
            id: current.entry.break.id,
            offset: current.resume - current.entry.break.start,
          };
        }
        load(primary.url, returnOptions(current.resume));
      }

      /** The last unplayed `noJump` break a seek from one time to another passes. */
      function jumped(from: number, to: number): Entry | undefined {
        return sorted()
          .filter(
            (e) =>
              e.break.noJump &&
              !played.has(e.break.id) &&
              e.break.cue === undefined &&
              e.break.assets.length + (e.break.assetList !== undefined ? 1 : 0) > 0 &&
              e.break.start > from &&
              e.break.start <= to,
          )
          .pop();
      }

      /** Follows the presentation's playhead: starts what it reaches, preloads what comes. */
      function follow(): void {
        if (playing !== null) {
          followAsset(playing);
          return;
        }
        if (primary === null || settling) return;
        const presentation = ctx.getState().presentation;
        if (presentation === null || presentation.id !== presentationId) {
          refresh();
        }
        const time = element.currentTime;
        const from = seekFrom ?? lastTime;
        const seeked = seekFrom !== null || Math.abs(time - lastTime) > JUMP;
        seekFrom = null;
        if (seeked) {
          // A seek back from the end: the presentation goes on, and so will its post-rolls.
          if (time < primaryHead.duration - 1) {
            ended = false;
            over = false;
          }
          // A seek back makes the breaks behind the new time playable again, unless once.
          for (const entry of entries.values()) {
            if (!entry.break.once && entry.break.start > time) played.delete(entry.break.id);
          }
          const passed = time > from ? jumped(from, time) : undefined;
          if (passed !== undefined) {
            lastTime = time;
            void begin(passed, time, passed.break.start);
            return;
          }
        }
        for (const entry of sorted()) {
          const b = entry.break;
          if (b.cue !== undefined) continue;
          if (b.assets.length === 0 && b.assetList === undefined) {
            if (isBreak(b)) stitched(entry, time);
            continue;
          }
          const start = startOf(b);
          const ahead = start - time;
          if (ahead > 0 && ahead <= Math.max(LOOKAHEAD, b.resolveAhead ?? 0) && !entry.preloaded) {
            entry.preloaded = true;
            void resolve(entry).then(() => {
              const first = entry.break.assets[0];
              if (first !== undefined)
                preload(
                  first.url,
                  first.mimeType !== undefined ? { mimeType: first.mimeType } : {},
                );
            });
          }
          // Playback crossed the start, or a seek landed inside a span the break covers.
          const crossed = !seeked && from < start + 0.001 && time >= start;
          const landed = seeked && b.covers > 0 && time >= start && time < b.start + b.covers;
          if (!played.has(b.id) && (crossed || landed)) {
            lastTime = time;
            void begin(entry, b.start + b.resumeOffset, start);
            return;
          }
        }
        lastTime = time;
        wake(time);
      }

      /** A break the presentation plays itself: report it as the playhead crosses it. */
      function stitched(entry: Entry, time: number): void {
        const b = entry.break;
        const inside = time >= b.start && time < b.start + Math.max(b.covers, 0.001);
        if (inside && !entry.inside) {
          entry.inside = true;
          entry.quartiles = 0;
          emit('break-start', entry, { stitched: true });
        }
        if (inside && b.covers > 0) {
          const fraction = (time - b.start) / b.covers;
          while (
            (entry.quartiles ?? 0) < QUARTILES.length &&
            fraction >= (QUARTILES[entry.quartiles ?? 0] ?? 1)
          ) {
            emit('progress', entry, { quartile: (entry.quartiles ?? 0) + 1 });
            entry.quartiles = (entry.quartiles ?? 0) + 1;
          }
        }
        if (!inside && entry.inside) {
          entry.inside = false;
          emit('break-end', entry, { stitched: true });
        }
      }

      function followAsset(current: Playing): void {
        const time = element.currentTime;
        if (element.seeking && current.entry.break.noSkip) {
          // A break that takes no seek goes back to where it was.
          if (Math.abs(time - current.last) > 0.5) element.currentTime = current.last;
          return;
        }
        current.last = time;
        const asset = current.entry.break.assets[current.asset];
        const length = Number.isFinite(element.duration) ? element.duration : asset?.duration;
        if (length !== undefined && length > 0) {
          const fraction = time / length;
          while (
            current.quartiles < QUARTILES.length &&
            fraction >= (QUARTILES[current.quartiles] ?? 1)
          ) {
            current.quartiles += 1;
            emit('progress', current.entry, { asset: current.asset, quartile: current.quartiles });
          }
        }
      }

      /** A timer to the next break start ahead, since `timeupdate` fires only every quarter second. */
      function wake(time: number): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (element.paused) return;
        let at = Number.POSITIVE_INFINITY;
        for (const entry of entries.values()) {
          const b = entry.break;
          for (const edge of [b.start - LOOKAHEAD, b.start, b.start + b.covers]) {
            if (edge > time) at = Math.min(at, edge);
          }
        }
        if (!Number.isFinite(at)) return;
        const rate = element.playbackRate > 0 ? element.playbackRate : 1;
        timer = setTimeout(follow, ((at - time) / rate) * 1000 + 10);
      }

      const onLoading = ctx.on('lifecycle:loading', (payload) => {
        if (own) return;
        // The page loaded another source: its breaks are the ones that count now.
        const { url, mimeType, start } = payload as {
          url: string;
          mimeType?: string;
          start?: number;
        };
        reset();
        primary = { url, ...(mimeType !== undefined ? { mimeType } : {}), start: start ?? 0 };
        // A load from a position of the presentation that left goes on with it.
        const kept = memory;
        memory = null;
        if (kept !== null && kept.url === url && start !== undefined) {
          for (const id of kept.played) played.add(id);
          for (const [id, assets] of kept.resolved) resolved.set(id, assets);
          started = true;
        }
      });
      /** After a return, the viewer's audio and subtitles again. */
      function restoreTracks(): void {
        if (tracks === null || settling || playing !== null) return;
        const state = ctx.getState();
        if (state.presentation === null) return;
        const active = [...state.tracks.active.values()];
        for (const trackId of tracks.values()) {
          if (state.tracks.available.includes(trackId) && !active.includes(trackId)) {
            ctx.dispatch({ type: 'SELECT_TRACK', trackId });
          }
        }
        tracks = null;
      }
      const onTracks = ctx.on('tracks:changed', () => {
        if (playing !== null) return;
        refresh();
        restoreTracks();
      });
      // A media playlist brings its date ranges when it merges.
      const onPresentation = ctx.on('presentation:changed', refresh);
      const onError = ctx.on('error', (payload) => {
        // An asset that fails is skipped; the break never stops the programme.
        const current = playing;
        if (current === null || (payload as { fatal?: boolean } | null)?.fatal !== true) return;
        ctx.emit('interstitials:warning', {
          id: current.entry.break.id,
          url: current.entry.break.assets[current.asset]?.url,
          reason: 'asset failed',
        });
        // After every listener of this error: a player reads `playing` to
        // tell an asset's error from the presentation's.
        queueMicrotask(() => {
          if (playing === current) next();
        });
      });

      const onSeeking = (): void => {
        if (playing === null && !settling) seekFrom ??= lastTime;
        follow();
      };
      /** The return landed: the presentation's own seek to the resume point is behind. */
      function settle(): void {
        settling = false;
        lastTime = element.currentTime;
        seekFrom = null;
        restoreTracks();
      }
      const onSeeked = (): void => {
        if (settling && playing === null) {
          settle();
          return;
        }
        follow();
      };
      const onPlaying = (): void => {
        switching = false;
        if (settling && playing === null) settle();
        if (playing === null) started = true;
        seekLive();
        follow();
      };
      const onPlay = (): void => {
        wanted = true;
        follow();
      };
      const onPause = (): void => {
        // A pause at a load or at the end of an asset is not the viewer's.
        if (!switching && !element.ended) wanted = false;
        follow();
      };
      const onCanPlay = (): void => {
        switching = false;
      };
      const onEnded = (): void => {
        // An asset's end can arrive after the next load began.
        if (!element.ended) return;
        if (playing !== null) {
          next();
          return;
        }
        if (ended || primary === null || settling) return;
        ended = true;
        const post = sorted().find((e) => e.break.cue === 'post' && !played.has(e.break.id));
        if (post !== undefined) {
          void begin(post, primaryHead.duration, element.currentTime, true);
          return;
        }
        over = true;
        ctx.emit('interstitials:ended', {});
      };
      const onTime = (): void => follow();
      element.addEventListener('timeupdate', onTime);
      element.addEventListener('play', onPlay);
      element.addEventListener('pause', onPause);
      element.addEventListener('canplay', onCanPlay);
      element.addEventListener('seeking', onSeeking);
      element.addEventListener('seeked', onSeeked);
      element.addEventListener('playing', onPlaying);
      element.addEventListener('ended', onEnded);

      const primaryHead: Playhead = {
        get currentTime() {
          return playing !== null ? playing.at : element.currentTime;
        },
        get duration() {
          return Number.isFinite(duration) ? duration : element.duration;
        },
        seek(time) {
          if (playing === null) {
            element.currentTime = time;
            return;
          }
          if (playing.entry.break.noSkip) return;
          playing.resume = time;
          finish();
        },
      };
      /** The inserted breaks behind a presentation time, which add their length to it. */
      const before = (time: number): number =>
        sorted()
          .filter(
            (e) =>
              e.break.covers === 0 &&
              e.break.cue !== 'post' &&
              (e.break.start < time || (played.has(e.break.id) && e.break.start <= time)),
          )
          .reduce((sum, e) => sum + lengthOf(e.break), 0);

      const api: InterstitialsApi = {
        get breaks() {
          return sorted().map((e) => e.break);
        },
        get ended() {
          if (over) return true;
          const due = sorted().some((e) => e.break.cue === 'post' && !played.has(e.break.id));
          return element.ended && playing === null && !pending && !settling && !due;
        },
        get playing() {
          return playing === null || playing.asset < 0
            ? null
            : { break: playing.entry.break, asset: playing.asset };
        },
        primary: primaryHead,
        integrated: {
          get currentTime() {
            if (playing === null) return element.currentTime + before(element.currentTime);
            // Inside an inserted break, the time already spent in it.
            const spent = playing.entry.break.assets
              .slice(0, Math.max(0, playing.asset))
              .reduce((sum, asset) => sum + (asset.duration ?? 0), 0);
            return playing.at + before(playing.at - 0.001) + spent + element.currentTime;
          },
          get duration() {
            const all = sorted()
              .filter((e) => e.break.covers === 0)
              .reduce((sum, e) => sum + lengthOf(e.break), 0);
            return primaryHead.duration + all;
          },
          seek(time) {
            let primaryTime = time;
            for (const entry of sorted()) {
              if (entry.break.covers > 0 || entry.break.start >= primaryTime) continue;
              primaryTime -= lengthOf(entry.break);
            }
            primaryHead.seek(Math.max(0, primaryTime));
          },
        },
        schedule(entry) {
          seq += 1;
          const id = entry.id ?? `page-${seq}`;
          const covers = entry.covers ?? 0;
          const value: Break = {
            id,
            source: 'page',
            start:
              entry.cue === 'pre'
                ? 0
                : entry.cue === 'post'
                  ? Number.isFinite(duration)
                    ? duration
                    : entry.start
                  : entry.start,
            ...(entry.cue !== undefined ? { cue: entry.cue } : {}),
            once: entry.once ?? false,
            assets: entry.assets,
            covers,
            resumeOffset: entry.resumeOffset ?? covers,
            noSkip: entry.noSkip ?? false,
            noJump: entry.noJump ?? false,
            ...(entry.skipAfter !== undefined ? { skipAfter: entry.skipAfter } : {}),
            attributes: {},
          };
          page.set(id, value);
          const known = entries.get(id);
          if (known !== undefined && playing?.entry !== known) known.break = value;
          else if (known === undefined) entries.set(id, { break: value });
          ctx.emit('interstitials:changed', { breaks: api.breaks });
          // A pre-roll a page schedules once its ad server answered still plays
          // when the presentation has just begun.
          if (value.cue === 'pre' && primary !== null && playing === null) {
            if (started && element.currentTime < 1)
              void begin(entries.get(id) as Entry, primary.start);
            else if (!started) refresh();
          }
          return value;
        },
        cancel(id) {
          const known = entries.get(id);
          if (known === undefined || playing?.entry === known) return;
          page.delete(id);
          entries.delete(id);
          ctx.emit('interstitials:changed', { breaks: api.breaks });
        },
        skip() {
          const current = playing;
          if (current === null) return false;
          // A break that takes no seek can still be skipped from `skipAfter`,
          // as a skippable ad is.
          const after = current.entry.break.skipAfter;
          if (current.entry.break.noSkip && after === undefined) return false;
          if (after !== undefined && element.currentTime < after) return false;
          ctx.emit('interstitials:skipped', { id: current.entry.break.id, asset: current.asset });
          next();
          return true;
        },
      };
      ctx.registerNamespace('interstitials', api);

      // Breaks in the media: alternative MPD and SCTE-35 events in emsg
      // (ISO/IEC 23009-1 §5.10.3.3), read beside the metadata stage, which
      // lists them too. After trick-play's fit (150); the asset's are not the
      // presentation's.
      ctx.registerTransform({
        name: 'interstitials-emsg',
        order: 161,
        transform(data, meta) {
          if (playing !== null || primary === null) return data;
          if (meta.contentType !== 'video' && meta.contentType !== 'audio') return data;
          if (meta.isInit || findBox(data, 'moov') !== null) {
            const scales = trackTimescales(data);
            if (scales.size > 0) timescales.set(meta.renditionId, scales);
          }
          let added = false;
          for (const { box, start, end } of placeEmsg(
            data,
            meta.start,
            timescales.get(meta.renditionId),
          )) {
            const entry = fromEvent(
              {
                scheme: box.scheme,
                ...(box.value !== '' ? { value: box.value } : {}),
                id: String(box.id),
                start,
                ...(end !== null ? { duration: end - start } : {}),
                data: bytesToBase64(box.data),
                timescale: box.timescale,
                elements: presentationElements(box.data),
              },
              primary.url,
            );
            if (entry === null || inband.has(entry.id)) continue;
            inband.set(entry.id, entry);
            added = true;
          }
          if (added) refresh();
          return data;
        },
      });

      return () => {
        if (primary !== null) {
          memory = { url: primary.url, played: [...played], resolved: new Map(resolved) };
        }
        onLoading();
        onTracks();
        onPresentation();
        onError();
        if (timer !== null) clearTimeout(timer);
        if (playing?.limit != null) clearTimeout(playing.limit);
        element.removeEventListener('timeupdate', onTime);
        element.removeEventListener('play', onPlay);
        element.removeEventListener('pause', onPause);
        element.removeEventListener('canplay', onCanPlay);
        element.removeEventListener('seeking', onSeeking);
        element.removeEventListener('seeked', onSeeked);
        element.removeEventListener('playing', onPlaying);
        element.removeEventListener('ended', onEnded);
      };
    },
  };
}
