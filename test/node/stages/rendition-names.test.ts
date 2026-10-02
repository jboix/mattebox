import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import renditionNames, {
  baseName,
  parseNameDictionary,
} from '../../../src/stages/rendition-names/index.js';
import type { Presentation, Track } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { StageContext } from '../../../src/types/stage.js';

// The example of the HLS 2nd Edition draft, Appendix E.4.
const DICTIONARY = `{
  "Director's commentary": { "en": "Director's commentary", "de": "Kommentar des Regisseurs" },
  "Kommentar des Regisseurs": { "en": "Director's commentary", "de": "Kommentar des Regisseurs" }
}`;

const audio = (name: string, lang: string, autoselect: boolean): Track => ({
  id: `AAC:${name}`,
  contentType: 'audio',
  mimeType: 'audio/mp4',
  name,
  lang,
  ...(autoselect ? { autoselect: true } : {}),
  protection: null,
  renditions: [],
});

// What a player builds on Intl.DisplayNames; a table stands in for it here.
const NAMES: Record<string, Record<string, string>> = {
  de: { en: 'Englisch', de: 'Deutsch' },
  en: { en: 'English', de: 'German' },
};
const languageName = (language: string, locale: string) => NAMES[locale]?.[language];

describe('Appendix E base name selection', () => {
  const dictionary = parseNameDictionary(DICTIONARY);

  it('translates a NAME the dictionary lists, and keeps the NAME for another locale', () => {
    const commentary = audio("Director's commentary", 'en', false);
    expect(baseName(commentary, 'de-CH', dictionary, languageName)).toBe(
      'Kommentar des Regisseurs',
    );
    expect(baseName(commentary, 'fr', dictionary, languageName)).toBe("Director's commentary");
  });

  it('names a primary rendition from its language, and falls back to the NAME without one', () => {
    const english = audio('English', 'en', true);
    expect(baseName(english, 'de', dictionary, languageName)).toBe('Englisch');
    expect(baseName(english, 'fr', dictionary, languageName)).toBe('English');
    expect(baseName(english, 'de', dictionary)).toBe('English');
    // Not primary: the NAME, never the language name.
    expect(baseName(audio('Deutsch', 'de', false), 'en', null, languageName)).toBe('Deutsch');
  });

  it('keeps only string translations, and refuses what is not a dictionary', () => {
    expect(parseNameDictionary('{"A": {"EN": "a", "fr": 3}, "B": 7}')).toEqual({ A: { en: 'a' } });
    expect(parseNameDictionary('[1]')).toBeNull();
    expect(parseNameDictionary('not json')).toBeNull();
  });
});

describe('the rendition-names stage', () => {
  it('fetches the session-data dictionary on load and answers names from it', () => {
    let slice: SliceReducer | null = null;
    let api: { nameOf(track: Track, locale: string): string | undefined } | null = null;
    let state: KernelState = { ...initialState(), lifecycle: { phase: 'attaching' } };
    renditionNames().install({
      reduce: (_: string, reducer: SliceReducer) => {
        slice = reducer;
      },
      registerNamespace: (_: string, value: typeof api) => {
        api = value;
      },
      getState: () => state,
    } as unknown as StageContext);
    const reduce = createReducer([['rendition-names', slice as unknown as SliceReducer]]);
    const presentation: Presentation = {
      id: 'p',
      isLive: false,
      couplings: [],
      periods: [{ id: 'p0', start: 0, tracks: [] }],
      sessionData: [
        { id: '_hls.localized-rendition-names', uri: 'https://cdn.example/names.json' },
      ],
    };
    let fx: readonly unknown[];
    [state, fx] = reduce(state, { type: 'MANIFEST_LOADED', presentation });
    expect(fx).toContainEqual(
      expect.objectContaining({ kind: 'fetch', url: 'https://cdn.example/names.json' }),
    );
    const bytes = new TextEncoder().encode(DICTIONARY).buffer as ArrayBuffer;
    [state, fx] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'rendition-names:dictionary',
      seq: 0,
      bytes,
      rtt: 1,
      size: bytes.byteLength,
    });
    expect(fx).toContainEqual(
      expect.objectContaining({ event: 'rendition-names:loaded', payload: { count: 2 } }),
    );
    const view = api as unknown as { nameOf(track: Track, locale: string): string | undefined };
    expect(view.nameOf(audio("Director's commentary", 'en', false), 'de')).toBe(
      'Kommentar des Regisseurs',
    );
    [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/next.m3u8' });
    expect(view.nameOf(audio("Director's commentary", 'en', false), 'de')).toBe(
      "Director's commentary",
    );
  });
});
