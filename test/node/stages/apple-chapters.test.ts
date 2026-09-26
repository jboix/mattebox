import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialState } from '../../../src/kernel/reducer.js';
import { parse } from '../../../src/protocols/hls-cmaf/parse.js';
import type { ChaptersApi } from '../../../src/stages/chapters/index.js';
import chapters from '../../../src/stages/chapters/index.js';
import { parseAppleChapters } from '../../../src/stages/chapters/parse.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { StageContext } from '../../../src/types/stage.js';

const ROOT = join(import.meta.dirname, '../../fixtures');
const BASE = 'https://cdn.example/vod/master.m3u8';

function fixture(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('EXT-X-SESSION-DATA', () => {
  it('keeps every entry in order, VALUE and LANGUAGE verbatim', () => {
    const presentation = parse(
      fixture('manifests/apple-tv-session-data-master.m3u8'),
      BASE,
    ).presentation;
    const data = presentation?.sessionData ?? [];
    // The iTunes-only EXT-X-SESSION-DATA-ITUNES line is not session data.
    expect(data.map((d) => d.id)).toEqual([
      'com.apple.hls.format',
      'com.apple.hls.feature.adam-id',
      'com.apple.hls.title',
      'com.apple.hls.poster',
      'com.apple.hls.genre',
      'com.apple.hls.release-date',
      'com.apple.hls.rating-tag',
      'com.apple.hls.rating-system',
      'com.apple.hls.rating-rank',
    ]);
    expect(data[2]).toEqual({
      id: 'com.apple.hls.title',
      value: 'Sicario: Day of the Soldado',
      lang: 'zh-tw',
    });
    expect(data[4]?.value).toBe('劇情片');
  });

  it('resolves a URI against the playlist', () => {
    const presentation = parse(
      fixture('manifests/shaka-hls-chapters-master.m3u8'),
      BASE,
    ).presentation;
    expect(presentation?.sessionData).toEqual([
      { id: 'com.apple.hls.chapters', uri: 'https://cdn.example/vod/chapters.json' },
    ]);
  });
});

describe("Apple's JSON chapters", () => {
  const DOC = 'https://cdn.example/vod/meta/chapters.json';

  it('reads start-time and duration', () => {
    const { chapters: list, warnings } = parseAppleChapters(
      fixture('chapters/shaka-hls-chapters.json'),
      DOC,
    );
    expect(warnings).toEqual([]);
    expect(list).toHaveLength(7);
    expect(list[1]).toMatchObject({
      id: '2',
      start: 102,
      end: 284,
      title: 'A dangerous quest',
      lang: 'und',
    });
    expect(list[6]).toMatchObject({ start: 744, end: 888 });
  });

  it('without duration, a chapter ends at the next start and the last stays open', () => {
    const { chapters: list } = parseAppleChapters(fixture('chapters/apple-tv-chapters.json'), DOC);
    expect(list).toHaveLength(8);
    expect(list[0]).toMatchObject({ start: 0, end: 846.44 });
    expect(list[7]?.end).toBe(Number.POSITIVE_INFINITY);
  });

  it('picks the title in the preferred language, else und, else the first', () => {
    const doc = JSON.stringify([
      {
        'start-time': 0,
        titles: [
          { language: 'fr', title: 'Début' },
          { language: 'en-US', title: 'Start' },
        ],
      },
      {
        'start-time': 10,
        titles: [
          { language: 'fr', title: 'Suite' },
          { language: 'und', title: '2' },
        ],
      },
    ]);
    const english = parseAppleChapters(doc, DOC, 'en').chapters;
    expect(english.map((c) => [c.title, c.lang])).toEqual([
      ['Start', 'en-US'],
      ['2', 'und'],
    ]);
    const none = parseAppleChapters(doc, DOC).chapters;
    expect(none.map((c) => c.title)).toEqual(['Début', '2']);
    // Every title stays under data for a page that wants another language.
    expect((english[0]?.data as { titles: unknown[] } | undefined)?.titles).toHaveLength(2);
  });

  it('takes the first image, resolved against the document, and keeps the rest as data', () => {
    const { chapters: list } = parseAppleChapters(fixture('chapters/apple-tv-chapters.json'), DOC);
    expect(list[0]?.image).toEqual({
      url: 'https://cdn.example/vod/meta/001_640x.jpg',
      width: 640,
      height: 360,
    });
    const data = list[0]?.data as { images: Array<{ 'image-category': string }>; chapter: number };
    expect(data.images[0]?.['image-category']).toBe('640x');
    expect(data.chapter).toBe(1);
  });

  it('keeps metadata items verbatim', () => {
    const doc = JSON.stringify([
      { 'start-time': 0, metadata: [{ key: 'com.example.scene', value: { id: 7 } }] },
    ]);
    const [chapter] = parseAppleChapters(doc, DOC).chapters;
    expect(chapter?.data).toEqual({ metadata: [{ key: 'com.example.scene', value: { id: 7 } }] });
    expect(chapter?.title).toBe('');
  });

  it('skips an entry without start-time and reports a document that is not an array', () => {
    const doc = JSON.stringify([{ duration: 5 }, { 'start-time': 3 }]);
    const result = parseAppleChapters(doc, DOC);
    expect(result.chapters).toHaveLength(1);
    expect(result.warnings).toEqual([{ reason: 'malformed-cue' }]);
    expect(parseAppleChapters('{}', DOC).warnings).toEqual([{ reason: 'bad-json' }]);
  });
});

/** The stage over a state the test drives through the stage's own reducer. */
function install(responses: Record<string, string> = {}) {
  let state: KernelState = initialState();
  let api: ChaptersApi | null = null;
  let reducer: SliceReducer | null = null;
  const events: Array<{ event: string; payload: unknown }> = [];
  const ctx = {
    getState: () => state,
    reduce: (_name: string, r: SliceReducer) => {
      reducer = r;
    },
    registerNamespace: (_name: string, value: object) => {
      api = value as ChaptersApi;
    },
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
    request: async (url: string) => {
      const body = responses[url];
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body, { status: 200 });
    },
  } as unknown as StageContext;
  chapters().install(ctx);
  return {
    api: api as unknown as ChaptersApi,
    events,
    send(msg: Message): readonly Effect[] {
      const [slice, effects] = (reducer as unknown as SliceReducer)(state.chapters, msg, state);
      state = { ...state, chapters: slice };
      return effects;
    },
    setPresentation(presentation: Presentation) {
      state = { ...state, presentation };
    },
  };
}

function manifest(): Presentation {
  const presentation = parse(
    fixture('manifests/shaka-hls-chapters-master.m3u8'),
    BASE,
  ).presentation;
  if (presentation === null) throw new Error('fixture failed to parse');
  return presentation;
}

function answer(text: string): Message {
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
  return { type: 'SEGMENT_LOADED', trackId: 'chapters:manifest', seq: 0, bytes, rtt: 1, size: 1 };
}

describe('chapters from the manifest', () => {
  it('fetches the document once and answers from it', () => {
    const { api, send } = install();
    const effects = send({ type: 'MANIFEST_LOADED', presentation: manifest() });
    expect(effects).toEqual([
      { kind: 'fetch', token: 'chapters:manifest', url: 'https://cdn.example/vod/chapters.json' },
    ]);
    // A reload of the same manifest does not fetch again.
    expect(send({ type: 'MANIFEST_LOADED', presentation: manifest() })).toEqual([]);
    const loaded = send(answer(fixture('chapters/shaka-hls-chapters.json')));
    expect(loaded).toContainEqual({
      kind: 'emit',
      event: 'chapters:changed',
      payload: { count: 7, source: 'manifest' },
    });
    expect(api.source).toBe('manifest');
    expect(api.at(300)?.title).toBe('The attack');
  });

  it('an app file wins, and the next LOAD clears both', async () => {
    const vtt = ['WEBVTT', '', '00:00.000 --> 00:10.000', 'Mine'].join('\n');
    const { api, send } = install({ 'https://cdn.example/mine.vtt': vtt });
    send({ type: 'MANIFEST_LOADED', presentation: manifest() });
    send(answer(fixture('chapters/shaka-hls-chapters.json')));
    await api.load('https://cdn.example/mine.vtt');
    expect(api.source).toBe('app');
    expect(api.at(1)?.title).toBe('Mine');
    send({ type: 'LOAD', url: 'https://cdn.example/next.m3u8' });
    expect(api.source).toBe('none');
    expect(api.all).toEqual([]);
  });

  it('chapters the app sets win over the manifest; an empty set brings them back', () => {
    const { api, send } = install();
    send({ type: 'MANIFEST_LOADED', presentation: manifest() });
    send(answer(fixture('chapters/shaka-hls-chapters.json')));
    api.set([{ start: 0, title: 'Mine' }]);
    expect(api.source).toBe('app');
    expect(api.at(300)?.title).toBe('Mine');
    api.set([]);
    expect(api.source).toBe('manifest');
    expect(api.at(300)?.title).toBe('The attack');
  });

  it('an open last chapter ends at the presentation duration once known', () => {
    const { api, send, setPresentation } = install();
    send({ type: 'MANIFEST_LOADED', presentation: manifest() });
    send(answer(fixture('chapters/apple-tv-chapters.json')));
    expect(api.all[7]?.end).toBe(Number.POSITIVE_INFINITY);
    setPresentation({ ...manifest(), duration: 7000 });
    expect(api.all[7]?.end).toBe(7000);
    expect(api.at(6999)?.id).toBe('8');
  });

  it('a failed fetch is a warning', () => {
    const { send } = install();
    send({ type: 'MANIFEST_LOADED', presentation: manifest() });
    const effects = send({
      type: 'SEGMENT_FAILED',
      trackId: 'chapters:manifest',
      seq: 0,
      error: { category: 'network', code: 'NETWORK_HTTP_STATUS', fatal: false, recoverable: true },
    });
    expect(effects).toEqual([
      {
        kind: 'emit',
        event: 'chapters:warning',
        payload: { url: 'https://cdn.example/vod/chapters.json', reason: 'fetch-failed' },
      },
    ]);
  });

  it('the app can load Apple JSON directly', async () => {
    const { api } = install({
      'https://cdn.example/chapters.json': fixture('chapters/shaka-hls-chapters.json'),
    });
    expect(await api.load('https://cdn.example/chapters.json')).toBe(7);
    expect(api.source).toBe('app');
  });
});
