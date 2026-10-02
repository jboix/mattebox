/**
 * Localized rendition names (HLS 2nd Edition, Appendix E). A multivariant
 * playlist can name a localization dictionary with
 * `EXT-X-SESSION-DATA:DATA-ID="_hls.localized-rendition-names",URI=...`: a
 * JSON object mapping each rendition NAME to its translations by primary
 * language subtag. This stage fetches it and answers a track's display name
 * for a locale with the Appendix E.2 base name selection:
 *
 * 1. The NAME has an entry: its translation for the locale, else the NAME.
 * 2. A primary rendition (AUTOSELECT=YES) without an entry: the language's
 *    name in the locale, from the caller's `languageName`.
 * 3. Otherwise the NAME.
 *
 * The engine calls no `Intl` API (its floor is Chromium 76, and
 * `Intl.DisplayNames` needs 81); a player passes `languageName` built on it
 * where the browser has it. Name decoration (forced, SDH, audio
 * description) is the player's.
 */
import type { Track } from '../../types/ir.js';
import type { SliceReducer } from '../../types/kernel.js';
import type { Effect } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';

/** Rendition NAME to translations, keyed by primary language subtag. */
export type NameDictionary = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The name of a language in a locale, or undefined when unknown. */
export type LanguageName = (language: string, locale: string) => string | undefined;

export interface RenditionNamesApi {
  /** The dictionary of the source loaded now; null when it has none, or before it loads. */
  readonly dictionary: NameDictionary | null;
  /** The track's base display name for a locale (Appendix E.2), or undefined when nothing names it. */
  nameOf(track: Track, locale: string, languageName?: LanguageName): string | undefined;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    renditionNames: RenditionNamesApi;
  }
}

const DATA_ID = '_hls.localized-rendition-names';
const FETCH_TOKEN = 'rendition-names:dictionary';

interface NamesSlice {
  readonly uri: string | null;
  readonly dictionary: NameDictionary | null;
}

const INITIAL: NamesSlice = { uri: null, dictionary: null };

/** The dictionary in a JSON document, keeping only string translations. */
export function parseNameDictionary(text: string): NameDictionary | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const out: Record<string, Record<string, string>> = {};
  for (const [name, translations] of Object.entries(json)) {
    if (typeof translations !== 'object' || translations === null) continue;
    const kept: Record<string, string> = {};
    for (const [language, value] of Object.entries(translations)) {
      if (typeof value === 'string') kept[language.toLowerCase()] = value;
    }
    out[name] = kept;
  }
  return out;
}

/** Appendix E.2 base name selection. */
export function baseName(
  track: Track,
  locale: string,
  dictionary: NameDictionary | null,
  languageName?: LanguageName,
): string | undefined {
  const subtag = (locale.split('-')[0] ?? '').toLowerCase();
  const entry = track.name === undefined ? undefined : dictionary?.[track.name];
  if (entry !== undefined) return entry[subtag] ?? track.name;
  if (track.autoselect === true && track.lang !== undefined && languageName !== undefined) {
    const localized = languageName(track.lang, locale);
    if (localized !== undefined && localized !== '') return localized;
  }
  return track.name;
}

const reduceNames: SliceReducer<NamesSlice> = (slice, msg) => {
  const state = slice ?? INITIAL;
  if (msg.type === 'LOAD' || msg.type === 'UNLOAD' || msg.type === 'DETACH') return [INITIAL, []];
  if (msg.type === 'MANIFEST_LOADED') {
    const uri = msg.presentation.sessionData?.find((d) => d.id === DATA_ID)?.uri;
    if (uri === undefined || uri === state.uri) return [state, []];
    return [{ ...state, uri }, [{ kind: 'fetch', token: FETCH_TOKEN, url: uri }]];
  }
  if (msg.type === 'SEGMENT_LOADED' && msg.trackId === FETCH_TOKEN && state.uri !== null) {
    const dictionary = parseNameDictionary(new TextDecoder().decode(msg.bytes));
    const effects: Effect[] = [
      dictionary === null
        ? {
            kind: 'emit',
            event: 'rendition-names:warning',
            payload: { url: state.uri, reason: 'not-a-dictionary' },
          }
        : {
            kind: 'emit',
            event: 'rendition-names:loaded',
            payload: { count: Object.keys(dictionary).length },
          },
    ];
    return [{ ...state, dictionary }, effects];
  }
  if (msg.type === 'SEGMENT_FAILED' && msg.trackId === FETCH_TOKEN) {
    return [
      state,
      [
        {
          kind: 'emit',
          event: 'rendition-names:warning',
          payload: { url: state.uri, reason: 'fetch-failed' },
        },
      ],
    ];
  }
  return [state, []];
};

export default function renditionNames(): Stage {
  return {
    name: 'rendition-names',
    provides: ['rendition-names'],
    requires: ['transport'],
    install(ctx) {
      ctx.reduce('rendition-names', reduceNames as SliceReducer);
      const dictionary = (): NameDictionary | null =>
        ((ctx.getState()['rendition-names'] as NamesSlice | undefined) ?? INITIAL).dictionary;
      ctx.registerNamespace('renditionNames', {
        get dictionary() {
          return dictionary();
        },
        nameOf(track, locale, languageName) {
          return baseName(track, locale, dictionary(), languageName);
        },
      } satisfies RenditionNamesApi);
    },
  };
}
