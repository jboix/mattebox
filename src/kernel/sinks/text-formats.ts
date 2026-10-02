/**
 * One text sink for every subtitle format. Each text stage joins it with
 * the parsers of its formats (`text/vtt`, `application/ttml+xml`,
 * `application/mp4;stpp`), and the sink parses each segment with the parser
 * of the format the reducer put on the segment's meta. A segment whose
 * format no stage parses fails as a container error on that segment, never
 * as an empty result.
 *
 * The first text stage to join registers the sink; the stages after it
 * share it. Stages install in order and tear down in reverse, so the first
 * leaves last and disposes the sink.
 *
 * Each stage also keeps the native tracks of its own formats in step with
 * the engine's text selection, both ways. Every such track exists natively
 * from the manifest on, so the browser's caption menu lists all of them;
 * the active one is `showing`, the rest `disabled`. A pick in that menu
 * selects in the engine, and switching captions off there deselects.
 */
import type { Track } from '../../types/ir.js';
import type { ParserFn, StageContext } from '../../types/stage.js';
import { cueFormat } from '../mime.js';
import { syncNativeTracks } from './native-sync.js';
import { type CueSink, createTextTrackSink } from './text-track-sink.js';

interface Shared {
  readonly sink: CueSink<'text'>;
  readonly parsers: Map<string, ParserFn>;
}

// Per element: an engine owns one element at a time, and every text stage
// of that engine joins the same sink.
const shared = new WeakMap<HTMLMediaElement, Shared>();

/** The cue format of a text track: its MIME type, with the codec family in fMP4. */
export function trackFormat(track: Track): string {
  return cueFormat(track.mimeType, track.renditions[0]?.codecs);
}

/** Joins the stage to the element's text sink with its parsers. Returns the stage's teardown. */
export function joinTextSink(
  ctx: StageContext,
  parsers: Readonly<Record<string, ParserFn>>,
): () => void {
  const { element } = ctx;
  let entry = shared.get(element);
  const owner = entry === undefined;
  if (entry === undefined) {
    const map = new Map<string, ParserFn>();
    const sink = createTextTrackSink({
      element,
      parse(data, meta) {
        const parse = map.get(meta.format ?? 'text/vtt');
        if (parse === undefined) throw new RangeError(`no parser for '${meta.format}'`);
        return parse(data, meta);
      },
    });
    entry = { sink, parsers: map };
    shared.set(element, entry);
    ctx.registerSink('text', () => sink);
  }
  const { sink } = entry;
  const formats = new Set(Object.keys(parsers));
  for (const [format, parse] of Object.entries(parsers)) {
    entry.parsers.set(format, parse);
    ctx.registerParser(format, parse);
  }

  function texts(): readonly Track[] {
    const presentation = ctx.getState().presentation;
    if (presentation === null) return [];
    return presentation.periods.flatMap((period) =>
      period.tracks.filter((track) => track.contentType === 'text'),
    );
  }

  // Every track of this stage's formats exists natively from the manifest
  // on, so the browser's caption menu lists them all. A track no longer in
  // the presentation (a new source on the same engine) is retired first, so
  // its last cue does not outlive it on screen.
  const stopSync = syncNativeTracks(ctx, {
    tracks: () => texts().filter((track) => formats.has(trackFormat(track))),
    native: (track) => sink.declare(track.id),
    idle: 'disabled',
    before() {
      const current = new Set(texts().map((track) => track.id));
      for (const id of sink.trackIds()) {
        if (!current.has(id)) sink.retire(id);
      }
    },
  });
  return () => {
    stopSync();
    for (const format of formats) entry.parsers.delete(format);
    if (owner) {
      sink.dispose();
      shared.delete(element);
    }
  };
}
