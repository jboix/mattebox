import { afterEach, describe, expect, it } from 'vitest';
import type { CueSink } from '../../../src/kernel/sinks/text-track-sink.js';
import textTtml from '../../../src/stages/text-ttml/index.js';
import textWebvtt from '../../../src/stages/text-webvtt/index.js';
import type { Track } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Effect, SegmentMeta } from '../../../src/types/messages.js';
import type { SinkFactory, StageContext } from '../../../src/types/stage.js';

/**
 * Every subtitle format shares one text sink; the format on each segment's
 * meta picks the parser. Two stages join through stub contexts on a real
 * element.
 */

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

const track = (id: string, mimeType: string, codecs: string | null = null): Track => ({
  id,
  contentType: 'text',
  mimeType,
  protection: null,
  renditions: [{ id, bitrate: 0, codecs, mimeType, segments: [] }],
});

function compose(tracks: readonly Track[]) {
  const element = document.createElement('video');
  const sinks: SinkFactory[] = [];
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  let active = new Map<string, string>();
  const ctx = {
    element,
    registerSink: (_type: string, factory: SinkFactory) => sinks.push(factory),
    registerParser() {},
    getState: () =>
      ({
        presentation: {
          id: 'p',
          isLive: false,
          couplings: [],
          periods: [{ id: 'p0', start: 0, tracks }],
        },
        tracks: { active, available: [] },
      }) as unknown as KernelState,
    dispatch() {},
    on(event: string, fn: (payload?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => {};
    },
  } as unknown as StageContext;
  for (const stage of [textWebvtt, textTtml]) {
    const teardown = stage().install(ctx);
    if (typeof teardown === 'function') teardowns.push(teardown);
  }
  for (const fn of listeners.get('tracks:changed') ?? []) fn();
  return {
    element,
    sinks,
    sink: sinks[0]?.({ element }) as unknown as CueSink<'text'>,
    select(id: string) {
      active = new Map([['text', id]]);
      for (const fn of listeners.get('tracks:selected') ?? []) fn({ contentType: 'text' });
    },
  };
}

const meta = (format: string): SegmentMeta => ({
  trackId: 'x',
  renditionId: 'x',
  contentType: 'text',
  seq: 0,
  start: 0,
  duration: 10,
  isInit: false,
  format,
});

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

function cueTexts(effects: readonly Effect[]): string[] {
  return effects.flatMap((e) => (e.kind === 'emitCues' ? e.cues.map((c) => c.text ?? '') : []));
}

describe('one text sink, a parser per format', () => {
  it('registers one sink for both stages and routes each segment by its format', () => {
    const h = compose([track('vtt', 'text/vtt'), track('ttml', 'application/ttml+xml')]);
    expect(h.sinks).toHaveLength(1);
    const vtt = h.sink.accept(
      'vtt',
      bytes('WEBVTT\n\n00:01.000 --> 00:02.000\nfrom vtt\n'),
      meta('text/vtt'),
    );
    expect(cueTexts(vtt)).toEqual(['from vtt']);
    const ttml = h.sink.accept(
      'ttml',
      bytes(
        '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s">from ttml</p></div></body></tt>',
      ),
      meta('application/ttml+xml'),
    );
    expect(cueTexts(ttml)).toEqual(['from ttml']);
  });

  it('fails a segment whose format no stage parses', () => {
    const h = compose([]);
    expect(() => h.sink.accept('w', bytes('x'), meta('application/mp4;wvtt'))).toThrow(RangeError);
  });

  it('mirrors each stage its own tracks: both listed natively, the selected one showing', () => {
    const h = compose([
      track('vtt', 'text/vtt'),
      track('stpp', 'application/mp4', 'stpp.ttml.im1t'),
    ]);
    const labels = [...h.element.textTracks].map((t) => t.label).sort();
    expect(labels).toEqual(['mattebox:stpp', 'mattebox:vtt']);
    h.select('stpp');
    expect(h.sink.nativeTrack('stpp')?.mode).toBe('showing');
    expect(h.sink.nativeTrack('vtt')?.mode).toBe('disabled');
  });
});
