/**
 * Chapters: named spans of the presentation, answered through
 * `engine.chapters`. Two sources fill it:
 *
 * - The manifest. An HLS EXT-X-SESSION-DATA entry with DATA-ID
 *   `com.apple.hls.chapters` names Apple's JSON chapters document. The
 *   stage's reducer fetches it once per load and parses it; the list lives
 *   in the stage's slice.
 * - A file the app loads: a WebVTT chapters track, the metadata track this
 *   engine defines (JSON cue payloads with an image and data), or Apple's
 *   JSON. It wins over the manifest until the next LOAD, UNLOAD, or DETACH.
 *
 * Both fetches go through the transport, so request hooks (auth, cmcd,
 * steering) apply. A load counter in the slice ties the app's list, which
 * lives outside kernel state, to the source loaded when it arrived.
 */
import { findTrackSite } from '../../kernel/presentation.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import type { Chapter, ChaptersResult } from './parse.js';
import { parseAppleChapters, parseChapterTrack } from './parse.js';

export type { Chapter, ChapterImage } from './parse.js';

declare module '../../index.js' {
  interface MatteboxNamespaces {
    chapters: ChaptersApi;
  }
}

export interface ChaptersApi {
  /** Fetches and parses a chapters file. Resolves to the chapter count. */
  load(url: string): Promise<number>;
  /** The chapter covering a presentation time, or null. */
  at(time: number): Chapter | null;
  /** Every chapter, in start order. */
  readonly all: readonly Chapter[];
  /** Where the current list came from. */
  readonly source: 'none' | 'app' | 'manifest';
}

/** The session-data id Apple's players read chapters from. */
const APPLE_CHAPTERS = 'com.apple.hls.chapters';
const FETCH_TOKEN = 'chapters:manifest';

interface ChaptersSlice {
  /** Moves on every LOAD, UNLOAD, and DETACH. */
  readonly loads: number;
  /** The chapters document this load asked for; a reload naming it again does not refetch. */
  readonly manifestUri: string | null;
  readonly manifest: readonly Chapter[] | null;
}

const INITIAL: ChaptersSlice = { loads: 0, manifestUri: null, manifest: null };

/** The active subtitle language picks among a document's titles. */
function preferredLanguage(kernel: Readonly<KernelState>): string | null {
  const textId = kernel.tracks.active.get('text');
  if (textId === undefined) return null;
  return findTrackSite(kernel.presentation, textId)?.track.lang ?? null;
}

/** A parse's warnings and the list-changed event, as emit effects. */
function report(url: string, result: ChaptersResult, source: 'app' | 'manifest'): Effect[] {
  return [
    ...result.warnings.map(
      (warning): Effect => ({
        kind: 'emit',
        event: 'chapters:warning',
        payload: { url, ...warning },
      }),
    ),
    {
      kind: 'emit',
      event: 'chapters:changed',
      payload: { count: result.chapters.length, source },
    },
  ];
}

/** Counts source changes, and finds, fetches, and parses the manifest's chapters. */
const reduceChapters: SliceReducer<ChaptersSlice> = (slice, msg, kernel) => {
  const state = slice ?? INITIAL;
  if (msg.type === 'LOAD' || msg.type === 'UNLOAD' || msg.type === 'DETACH') {
    return [
      { ...INITIAL, loads: state.loads + 1 },
      [{ kind: 'emit', event: 'chapters:changed', payload: { count: 0, source: 'none' } }],
    ];
  }
  if (msg.type === 'MANIFEST_LOADED') {
    const uri = msg.presentation.sessionData?.find((d) => d.id === APPLE_CHAPTERS)?.uri;
    if (uri === undefined || uri === state.manifestUri) return [state, []];
    return [{ ...state, manifestUri: uri }, [{ kind: 'fetch', token: FETCH_TOKEN, url: uri }]];
  }
  if (msg.type === 'SEGMENT_LOADED' && msg.trackId === FETCH_TOKEN && state.manifestUri !== null) {
    const text = new TextDecoder().decode(msg.bytes);
    const result = parseAppleChapters(text, state.manifestUri, preferredLanguage(kernel));
    return [{ ...state, manifest: result.chapters }, report(state.manifestUri, result, 'manifest')];
  }
  if (msg.type === 'SEGMENT_FAILED' && msg.trackId === FETCH_TOKEN) {
    const payload = { url: state.manifestUri, reason: 'fetch-failed' };
    return [state, [{ kind: 'emit', event: 'chapters:warning', payload }]];
  }
  return [state, []];
};

export default function chapters(): Stage {
  return {
    name: 'chapters',
    provides: ['chapters'],
    requires: ['transport'],
    install(ctx) {
      ctx.reduce('chapters', reduceChapters as SliceReducer);
      let list: { loads: number; chapters: readonly Chapter[] } | null = null;

      const slice = (): ChaptersSlice =>
        (ctx.getState().chapters as ChaptersSlice | undefined) ?? INITIAL;
      /** The app's list, when it belongs to the source loaded now. */
      const app = (): readonly Chapter[] | null =>
        list !== null && list.loads === slice().loads ? list.chapters : null;
      /**
       * The list in force. A last chapter with no end runs to the end of the
       * presentation, known once a media playlist has loaded.
       */
      const current = (): readonly Chapter[] => {
        const chosen = app() ?? slice().manifest ?? [];
        const duration = ctx.getState().presentation?.duration;
        if (duration === undefined) return chosen;
        return chosen.map((c) =>
          c.end === Number.POSITIVE_INFINITY ? { ...c, end: duration } : c,
        );
      };

      const api: ChaptersApi = {
        async load(url: string): Promise<number> {
          const at = slice().loads;
          const response = await ctx.request(url, { method: 'GET' });
          if (!response.ok) throw new TypeError(`chapters ${url}: HTTP ${response.status}`);
          const text = await response.text();
          // The response URL is absolute and follows redirects; a path-only
          // `url` would leave the file's relative image URLs unresolvable.
          const base = response.url || url;
          // The content decides the format: a WebVTT signature past a BOM, or a JSON array.
          let result: ChaptersResult;
          if (/^﻿?WEBVTT/.test(text)) {
            result = parseChapterTrack(text, base);
          } else if (text.trimStart().startsWith('[')) {
            result = parseAppleChapters(text, base, preferredLanguage(ctx.getState()));
          } else {
            throw new TypeError(`chapters ${url}: neither WebVTT nor a JSON chapters array`);
          }
          const effects = report(url, result, 'app');
          // Another source loaded while this file was on its way: it no longer applies.
          if (at !== slice().loads) return result.chapters.length;
          list = { loads: at, chapters: result.chapters };
          for (const effect of effects) {
            if (effect.kind === 'emit') ctx.emit(effect.event, effect.payload);
          }
          return result.chapters.length;
        },
        at(time: number): Chapter | null {
          return current().find((c) => time >= c.start && time < c.end) ?? null;
        },
        get all() {
          return current();
        },
        get source() {
          if (app() !== null) return 'app';
          return slice().manifest === null ? 'none' : 'manifest';
        },
      };
      ctx.registerNamespace('chapters', api);
    },
  };
}
