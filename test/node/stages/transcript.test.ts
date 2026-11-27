import { describe, expect, it } from 'vitest';
import { parseVtt } from '../../../src/containers/webvtt.js';
import { initialState } from '../../../src/kernel/reducer.js';
import { shiftTimestampMap } from '../../../src/stages/text-webvtt-segmented/index.js';
import type { TranscriptApi } from '../../../src/stages/transcript/index.js';
import transcript from '../../../src/stages/transcript/index.js';
import type { Presentation, Rendition, Segment, Track } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Command, Message } from '../../../src/types/messages.js';
import type { Capability, StageContext } from '../../../src/types/stage.js';

const BASE = 'https://cdn.example/subs/';

/** A WebVTT segment whose cue times are local, mapped onto the programme by its timestamp map. */
function vtt(offset: number, ...cues: Array<[number, number, string]>): string {
  const stamp = (seconds: number): string => {
    const whole = Math.floor(seconds);
    const ms = Math.round((seconds - whole) * 1000);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}.${pad(ms, 3)}`;
  };
  const body = cues.map(([start, end, text]) => `${stamp(start)} --> ${stamp(end)}\n${text}\n`);
  return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${offset * 90_000},LOCAL:00:00:00.000\n\n${body.join('\n')}`;
}

/** Four segments of ten seconds; the cue at 18 s crosses into the third and is in both. */
const FILES: Record<string, string> = {
  'en-0.vtt': vtt(
    0,
    [1, 4, 'The first train leaves the valley.'],
    [6, 9, 'It climbs for an hour.'],
  ),
  'en-1.vtt': vtt(10, [2, 5, 'Then the snow begins.'], [8, 12, 'The crew clears the track.']),
  'en-2.vtt': vtt(10, [8, 12, 'The crew clears the track.'], [14, 17, 'The plough goes first.']),
  'en-3.vtt': vtt(30, [1, 3, '<i>By noon</i> the train is at the top.'], [5, 6, '  ']),
};

function segments(prefix: string, count = 4): Segment[] {
  return Array.from({ length: count }, (_, seq) => ({
    seq,
    start: seq * 10,
    duration: 10,
    url: `${BASE}${prefix}-${seq}.vtt`,
  }));
}

function textTrack(id: string, rendition: Partial<Rendition>, extra: Partial<Track> = {}): Track {
  return {
    id,
    contentType: 'text',
    mimeType: 'text/vtt',
    protection: null,
    renditions: [
      { id: `r-${id}`, bitrate: 0, codecs: null, mimeType: 'text/vtt', segments: [], ...rendition },
    ],
    ...extra,
  } as Track;
}

function presentationOf(...tracks: Track[]): Presentation {
  return { id: 'p', periods: [{ id: 'period-0', start: 0, tracks }] } as unknown as Presentation;
}

interface Rig {
  readonly api: TranscriptApi;
  /** The URLs asked of the transport, in order. */
  readonly requested: string[];
  readonly dispatched: Command[];
  /** Replaces the presentation and tells the listeners, as a merged playlist does. */
  present(presentation: Presentation): void;
  /** Sends a message through the stage's slice reducer. */
  send(msg: Message): void;
  fail(url: string): void;
}

function rig(presentation: Presentation, capabilities?: readonly Capability[]): Rig {
  let state: KernelState = { ...initialState(), presentation };
  let reducer: SliceReducer | null = null;
  let api: TranscriptApi | null = null;
  const requested: string[] = [];
  const dispatched: Command[] = [];
  const failing = new Set<string>();
  const listeners = new Set<() => void>();
  const ctx: StageContext = {
    element: new EventTarget() as unknown as HTMLMediaElement,
    registerSink: () => undefined,
    registerParser: () => undefined,
    capabilities: () => capabilities ?? [{ contentType: 'text', mimeType: 'text/vtt' }],
    registerTransform: () => undefined,
    // The segmented WebVTT transform, then the WebVTT parser: what the engine runs.
    parseCues: async (data) => parseVtt(shiftTimestampMap(new TextDecoder().decode(data))).cues,
    registerNamespace: (_name, namespace) => {
      api = namespace as TranscriptApi;
    },
    registerChooser: () => undefined,
    registerSwitchPolicy: () => undefined,
    registerTypeProbe: () => undefined,
    registerTimeProbe: () => undefined,
    registerChunkSplitter: () => undefined,
    getState: () => state,
    addRequestHook: () => () => undefined,
    addResponseHook: () => () => undefined,
    request: async (url) => {
      requested.push(url);
      if (failing.has(url)) return new Response('', { status: 503 });
      const body = FILES[url.slice(BASE.length)];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    },
    reduce: (_name, slice) => {
      reducer = slice as SliceReducer;
    },
    dispatch: (cmd) => {
      dispatched.push(cmd);
    },
    load: () => undefined,
    preload: async () => undefined,
    emit: () => undefined,
    on: (_event, fn) => {
      const listener = (): void => fn(undefined);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  transcript().install(ctx);
  if (api === null) throw new Error('the stage registered no namespace');
  return {
    api,
    requested,
    dispatched,
    present(next) {
      state = { ...state, presentation: next };
      for (const listener of [...listeners]) listener();
    },
    send(msg) {
      const [slice] = (reducer as SliceReducer)(state.transcript, msg, state);
      state = { ...state, transcript: slice };
    },
    fail(url) {
      failing.add(url);
    },
  };
}

const english = (): Track => textTrack('subs-en', { segments: segments('en') });
const names = (urls: readonly string[]): string[] => urls.map((url) => url.slice(BASE.length));

describe('the transcript stage lists the tracks it can read', () => {
  it('a text track in a format a stage parses, and no in-band captions', () => {
    const captions = textTrack('cc1', {}, { instreamId: 'CC1' });
    const { api } = rig(presentationOf(english(), captions));
    expect(api.tracks).toEqual(['subs-en']);
  });

  it('no track whose format no stage parses', () => {
    const { api } = rig(presentationOf(english()), [
      { contentType: 'text', mimeType: 'application/ttml+xml' },
    ]);
    expect(api.tracks).toEqual([]);
  });
});

describe('the transcript stage reads cues apart from playback', () => {
  it('loads nothing until it is asked', () => {
    const { requested } = rig(presentationOf(english()));
    expect(requested).toEqual([]);
  });

  it('reads the segments that overlap the range, and places their cues on the programme', async () => {
    const { api, requested } = rig(presentationOf(english()));
    const cues = await api.cues('subs-en', { start: 12, end: 20 });
    expect(names(requested)).toEqual(['en-1.vtt']);
    expect(cues).toEqual([
      { start: 12, end: 15, text: 'Then the snow begins.' },
      { start: 18, end: 22, text: 'The crew clears the track.' },
    ]);
  });

  it('reads the whole programme without a range, each cue once and by start', async () => {
    const { api, requested } = rig(presentationOf(english()));
    const cues = await api.cues('subs-en');
    expect(names(requested).sort()).toEqual(['en-0.vtt', 'en-1.vtt', 'en-2.vtt', 'en-3.vtt']);
    expect(cues.map((cue) => cue.start)).toEqual([1, 6, 12, 18, 24, 31]);
    // The cue at 18 s is in two segments; a cue of spaces is no line.
    expect(cues.filter((cue) => cue.start === 18)).toHaveLength(1);
    expect(cues[5]?.text).toBe('<i>By noon</i> the train is at the top.');
  });

  it('reads a segment once for a source', async () => {
    const { api, requested } = rig(presentationOf(english()));
    await api.cues('subs-en', { start: 0, end: 15 });
    await api.cues('subs-en', { start: 5, end: 25 });
    expect(names(requested)).toEqual(['en-0.vtt', 'en-1.vtt', 'en-2.vtt']);
  });

  it('asks for the segment list of a track that is not showing, once, and waits for it', async () => {
    const r = rig(presentationOf(textTrack('subs-en', { segments: [] })));
    const first = r.api.cues('subs-en', { start: 0, end: 5 });
    const second = r.api.cues('subs-en', { start: 0, end: 5 });
    expect(r.dispatched).toEqual([{ type: 'RESOLVE_RENDITION', renditionId: 'r-subs-en' }]);
    expect(r.requested).toEqual([]);

    r.present(presentationOf(english()));
    expect((await first).map((cue) => cue.start)).toEqual([1, 6]);
    expect(await second).toEqual(await first);
    expect(names(r.requested)).toEqual(['en-0.vtt']);
  });

  it('rejects for a track it does not know', async () => {
    const { api } = rig(presentationOf(english()));
    await expect(api.cues('subs-fr')).rejects.toThrow(RangeError);
  });

  it('rejects when a segment fails, and reads it again at the next call', async () => {
    const r = rig(presentationOf(english()));
    r.fail(`${BASE}en-0.vtt`);
    await expect(r.api.cues('subs-en', { start: 0, end: 5 })).rejects.toThrow('HTTP 503');
    await expect(r.api.cues('subs-en', { start: 0, end: 5 })).rejects.toThrow('HTTP 503');
    expect(names(r.requested)).toEqual(['en-0.vtt', 'en-0.vtt']);
  });

  it('rejects when another source loads meanwhile, and forgets what it read', async () => {
    const r = rig(presentationOf(english()));
    await r.api.cues('subs-en', { start: 0, end: 5 });
    const pending = r.api.cues('subs-en', { start: 10, end: 15 });
    r.send({ type: 'LOAD', url: 'https://cdn.example/next.m3u8' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    await r.api.cues('subs-en', { start: 0, end: 5 });
    expect(names(r.requested)).toEqual(['en-0.vtt', 'en-1.vtt', 'en-0.vtt']);
  });

  it('stops when the caller aborts', async () => {
    const r = rig(presentationOf(textTrack('subs-en', { segments: [] })));
    const control = new AbortController();
    const pending = r.api.cues('subs-en', { signal: control.signal });
    control.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('needs an end for a live template, which has no last segment', async () => {
    const live = textTrack('subs-en', {
      segments: {
        kind: 'indexed',
        timescale: 1,
        startSeq: 0,
        endSeq: null,
        segmentDuration: 10,
        timeline: null,
        urlTemplate: `${BASE}en-$Number$.vtt`,
      } as unknown as Rendition['segments'],
    });
    const r = rig(presentationOf(live));
    await expect(r.api.cues('subs-en')).rejects.toThrow(RangeError);
    const cues = await r.api.cues('subs-en', { start: 0, end: 20 });
    expect(names(r.requested)).toEqual(['en-0.vtt', 'en-1.vtt']);
    expect(cues).toHaveLength(4);
  });
});
