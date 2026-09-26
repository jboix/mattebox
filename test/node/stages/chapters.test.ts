import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialState } from '../../../src/kernel/reducer.js';
import type { ChaptersApi } from '../../../src/stages/chapters/index.js';
import chapters from '../../../src/stages/chapters/index.js';
import { parseChapterTrack } from '../../../src/stages/chapters/parse.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Message } from '../../../src/types/messages.js';
import type { StageContext } from '../../../src/types/stage.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/chapters');
const BASE = 'https://cdn.example/vod/chapters/big-buck-bunny.vtt';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('a chapters track', () => {
  it('each cue is a chapter titled by its payload', () => {
    const { chapters: list, warnings } = parseChapterTrack(fixture('big-buck-bunny.vtt'), BASE);
    expect(warnings).toEqual([]);
    expect(list.map((c) => c.title)).toEqual([
      'A morning in the meadow',
      'The rodents',
      'The butterfly',
      'Bunny fights back',
      'Credits',
    ]);
    expect(list[1]).toMatchObject({ start: 60, end: 205 });
    expect(list[0]?.image).toBeUndefined();
    expect(list[0]?.data).toBeUndefined();
  });

  it('keeps a cue id and an authored gap', () => {
    const vtt = [
      'WEBVTT',
      '',
      'intro',
      '00:00.000 --> 00:10.000',
      'Intro',
      '',
      '00:20.000 --> 00:30.000',
      'Later',
    ].join('\n');
    const { chapters: list } = parseChapterTrack(vtt, BASE);
    expect(list[0]).toMatchObject({ id: 'intro', end: 10 });
    expect(list[1]).toMatchObject({ start: 20 });
  });

  it('truncates an overlap and reports it', () => {
    const vtt = [
      'WEBVTT',
      '',
      'b',
      '00:10.000 --> 00:30.000',
      'B',
      '',
      'a',
      '00:00.000 --> 00:15.000',
      'A',
    ].join('\n');
    const { chapters: list, warnings } = parseChapterTrack(vtt, BASE);
    expect(list.map((c) => [c.id, c.start, c.end])).toEqual([
      ['a', 0, 10],
      ['b', 10, 30],
    ]);
    expect(warnings).toEqual([{ reason: 'overlap', id: 'a' }]);
  });
});

describe('the metadata track', () => {
  const { chapters: list, warnings } = parseChapterTrack(
    fixture('big-buck-bunny-metadata.vtt'),
    BASE,
  );

  it('reads every JSON cue', () => {
    expect(list).toHaveLength(5);
    expect(list[2]).toMatchObject({ title: 'The butterfly' });
    expect(list[3]).toMatchObject({ title: 'Bunny fights back', lang: 'en' });
    expect(warnings).toEqual([]);
  });

  it('mixes JSON cues and plain cues in one file', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00.000 --> 00:10.000',
      '{ "title": "With an image", "image": "a.jpg" }',
      '',
      '00:10.000 --> 00:20.000',
      'Plain title',
    ].join('\n');
    const result = parseChapterTrack(vtt, BASE);
    expect(result.chapters.map((c) => [c.title, c.image?.url])).toEqual([
      ['With an image', 'https://cdn.example/vod/chapters/a.jpg'],
      ['Plain title', undefined],
    ]);
  });

  it('resolves an image given as a string or an object against the file', () => {
    expect(list[0]?.image).toEqual({ url: 'https://cdn.example/vod/chapters/images/meadow.jpg' });
    expect(list[1]?.image).toEqual({
      url: 'https://cdn.example/vod/chapters/images/rodents.jpg',
      width: 320,
      height: 180,
    });
  });

  it('keeps every other field as data, verbatim', () => {
    expect(list[1]?.data).toEqual({ cast: ['Frank', 'Rinky', 'Gamera'] });
    expect(list[0]?.data).toBeUndefined();
  });

  it('a payload that is not a JSON object stays the title, with a warning', () => {
    const vtt = ['WEBVTT', '', 'odd', '00:00.000 --> 00:10.000', '{ not json'].join('\n');
    const result = parseChapterTrack(vtt, BASE);
    expect(result.chapters[0]).toMatchObject({ title: '{ not json' });
    expect(result.warnings).toEqual([{ reason: 'bad-json', id: 'odd' }]);
  });
});

/** Installs the stage against a state the test controls, recording events. */
function install(responses: Record<string, string>, finalUrls: Record<string, string> = {}) {
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
      if (body === undefined) return new Response('missing', { status: 404 });
      const response = new Response(body, { status: 200 });
      // fetch sets the final URL; a constructed Response has none.
      const final = finalUrls[url];
      if (final !== undefined) Object.defineProperty(response, 'url', { value: final });
      return response;
    },
  } as unknown as StageContext;
  chapters().install(ctx);
  return {
    api: api as unknown as ChaptersApi,
    events,
    /** Runs a message through the stage's slice, as the loader would. */
    send(msg: Message) {
      const [slice, effects] = (reducer as unknown as SliceReducer)(state.chapters, msg, state);
      state = { ...state, chapters: slice };
      return effects;
    },
  };
}

describe('engine.chapters', () => {
  const URL = 'https://cdn.example/bbb.vtt';

  it('loads a track and answers by time', async () => {
    const { api, events } = install({ [URL]: fixture('big-buck-bunny.vtt') });
    expect(api.source).toBe('none');
    expect(await api.load(URL)).toBe(5);
    expect(api.source).toBe('app');
    expect(api.at(61)?.title).toBe('The rodents');
    expect(api.at(9999)).toBeNull();
    expect(events).toContainEqual({
      event: 'chapters:changed',
      payload: { count: 5, source: 'app' },
    });
  });

  it('rejects an HTTP error and a body that is not WebVTT', async () => {
    const { api } = install({ 'https://cdn.example/page.html': '<html></html>' });
    await expect(api.load('https://cdn.example/none.vtt')).rejects.toThrow('HTTP 404');
    await expect(api.load('https://cdn.example/page.html')).rejects.toThrow(
      'neither WebVTT nor a JSON chapters array',
    );
  });

  it('LOAD clears the list and reports it', async () => {
    const { api, send } = install({ [URL]: fixture('big-buck-bunny.vtt') });
    await api.load(URL);
    const effects = send({ type: 'LOAD', url: 'https://cdn.example/next.m3u8' });
    expect(api.all).toEqual([]);
    expect(api.source).toBe('none');
    expect(effects).toContainEqual({
      kind: 'emit',
      event: 'chapters:changed',
      payload: { count: 0, source: 'none' },
    });
  });

  it('a file answered after the next source loaded does not apply', async () => {
    const { api, send } = install({ [URL]: fixture('big-buck-bunny.vtt') });
    const pending = api.load(URL);
    send({ type: 'UNLOAD' });
    await pending;
    expect(api.all).toEqual([]);
  });

  it('resolves images against the response URL, so a path-only request works', async () => {
    const { api } = install(
      { '/chapters/bbb.vtt': fixture('big-buck-bunny-metadata.vtt') },
      {
        '/chapters/bbb.vtt': 'https://site.example/chapters/bbb.vtt',
      },
    );
    await api.load('/chapters/bbb.vtt');
    expect(api.all[0]?.image?.url).toBe('https://site.example/chapters/images/meadow.jpg');
  });

  it('reports warnings with the file URL', async () => {
    const vtt = ['WEBVTT', '', 'odd', '00:00.000 --> 00:10.000', '{ nope'].join('\n');
    const { api, events } = install({ [URL]: vtt });
    await api.load(URL);
    expect(events).toContainEqual({
      event: 'chapters:warning',
      payload: { url: URL, reason: 'bad-json', id: 'odd' },
    });
  });
});

describe('engine.chapters.set', () => {
  // Chapters as an app maps them from a content API: the SRG SSR integration
  // layer gives fullLengthMarkIn and fullLengthMarkOut in milliseconds.
  const il = [
    {
      urn: 'urn:rts:video:2',
      fullLengthMarkIn: 300_000,
      fullLengthMarkOut: 600_000,
      title: 'Sport',
      imageUrl: 'https://img.example/2.jpg',
    },
    {
      urn: 'urn:rts:video:1',
      fullLengthMarkIn: 0,
      fullLengthMarkOut: 300_000,
      title: 'News',
      imageUrl: 'https://img.example/1.jpg',
    },
  ];
  const mapped = il.map((c) => ({
    id: c.urn,
    start: c.fullLengthMarkIn / 1000,
    end: c.fullLengthMarkOut / 1000,
    title: c.title,
    image: { url: c.imageUrl },
    data: { urn: c.urn },
  }));

  it('answers from chapters the app holds, in start order', () => {
    const { api, events } = install({});
    expect(api.set(mapped)).toBe(2);
    expect(api.source).toBe('app');
    expect(api.all.map((c) => c.title)).toEqual(['News', 'Sport']);
    expect(api.at(301)).toMatchObject({
      id: 'urn:rts:video:2',
      start: 300,
      end: 600,
      image: { url: 'https://img.example/2.jpg' },
      data: { urn: 'urn:rts:video:2' },
    });
    expect(events).toContainEqual({
      event: 'chapters:changed',
      payload: { count: 2, source: 'app' },
    });
  });

  it('a missing end runs to the next start, the last to the end of the presentation', () => {
    const { api } = install({});
    api.set([
      { start: 10, title: 'B' },
      { start: 0, title: 'A' },
    ]);
    expect(api.all.map((c) => [c.title, c.start, c.end])).toEqual([
      ['A', 0, 10],
      ['B', 10, Number.POSITIVE_INFINITY],
    ]);
    expect(api.all[0]?.id).toBe('0');
  });

  it('skips an entry without a usable start, with a warning', () => {
    const { api, events } = install({});
    expect(api.set([{ start: Number.NaN, id: 'bad' }, { start: -1 }, { start: 5 }])).toBe(1);
    expect(events).toContainEqual({
      event: 'chapters:warning',
      payload: { reason: 'invalid-chapter', id: 'bad' },
    });
  });

  it('cuts an overlap, as for files', () => {
    const { api } = install({});
    api.set([
      { start: 0, end: 20, id: 'a' },
      { start: 10, end: 30, id: 'b' },
    ]);
    expect(api.all.map((c) => [c.id, c.end])).toEqual([
      ['a', 10],
      ['b', 30],
    ]);
  });

  it('an empty list removes the app chapters, and the next LOAD clears them too', () => {
    const { api, send } = install({});
    api.set(mapped);
    expect(api.set([])).toBe(0);
    expect(api.source).toBe('none');
    api.set(mapped);
    send({ type: 'LOAD', url: 'https://cdn.example/next.m3u8' });
    expect(api.all).toEqual([]);
  });
});
