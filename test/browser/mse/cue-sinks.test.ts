import { describe, expect, it } from 'vitest';
import { createMetadataSink } from '../../../src/kernel/sinks/metadata-sink.js';
import { createTextTrackSink } from '../../../src/kernel/sinks/text-track-sink.js';

const meta = {
  trackId: 't-de',
  renditionId: 'subs-1',
  contentType: 'text' as const,
  seq: 0,
  start: 0,
  duration: 6,
  isInit: false,
};

describe('cue sinks', () => {
  it('text goes to a native TextTrack and reports coverage as ranges', () => {
    const el = document.createElement('video');
    const sink = createTextTrackSink({ element: el });

    // Without a parser the segment is consumed and covered, no cues.
    expect(sink.accept('t-de', new ArrayBuffer(16), meta)).toEqual([]);
    expect(sink.ranges('t-de')).toEqual([{ start: 0, end: 6 }]);

    sink.handleEmitCues('t-de', [
      { id: 'c1', start: 1, end: 2, text: 'Grüezi' },
      { start: 3, end: 4, text: 'mitenand' },
    ]);
    const native = sink.nativeTrack('t-de');
    expect(native?.cues?.length).toBe(2);
    expect(el.textTracks.length).toBe(1);
    expect(native?.kind).toBe('subtitles');

    sink.clear('t-de', 0, 2.5);
    expect(native?.cues?.length).toBe(1);
    expect(sink.ranges('t-de')).toEqual([{ start: 2.5, end: 6 }]);
  });

  it('declare creates the native track ahead of any segment, once', () => {
    const el = document.createElement('video');
    const sink = createTextTrackSink({ element: el });
    const first = sink.declare('t-de');
    expect(el.textTracks.length).toBe(1);
    expect(sink.declare('t-de')).toBe(first);
    expect(sink.nativeTrack('t-de')).toBe(first);
    // A segment for a declared track lands on the same native track.
    sink.accept('t-de', new ArrayBuffer(16), meta);
    expect(el.textTracks.length).toBe(1);
  });

  it('a second sink on the same element adopts the native track instead of duplicating it', () => {
    const el = document.createElement('video');
    const first = createTextTrackSink({ element: el });
    first.handleEmitCues('t-de', [{ start: 1, end: 2, text: 'old' }]);
    first.declare('t-de').mode = 'disabled';

    const second = createTextTrackSink({ element: el });
    const adopted = second.declare('t-de');
    expect(el.textTracks.length).toBe(1);
    expect(adopted).toBe(first.nativeTrack('t-de'));
    expect(adopted.mode).toBe('hidden');
    expect(adopted.cues?.length).toBe(0);
  });

  it('retire empties and disables a track; dispose retires them all, idempotently', () => {
    const el = document.createElement('video');
    const sink = createTextTrackSink({ element: el });
    sink.handleEmitCues('t-de', [{ start: 1, end: 2, text: 'eins' }]);
    sink.handleEmitCues('t-fr', [{ start: 1, end: 2, text: 'un' }]);
    sink.declare('t-de').mode = 'showing';
    expect(sink.trackIds()).toEqual(['t-de', 't-fr']);

    sink.retire('t-de');
    const de = [...el.textTracks].find((t) => t.label.endsWith(':t-de')) as TextTrack;
    expect(de.mode).toBe('disabled');
    de.mode = 'hidden';
    expect(de.cues?.length).toBe(0);
    expect(sink.trackIds()).toEqual(['t-fr']);
    expect(sink.nativeTrack('t-de')).toBeNull();

    sink.dispose();
    sink.dispose();
    expect(sink.trackIds()).toEqual([]);
    const fr = [...el.textTracks].find((t) => t.label.endsWith(':t-fr')) as TextTrack;
    expect(fr.mode).toBe('disabled');
    // The element keeps both native tracks; they are just empty and off.
    expect(el.textTracks.length).toBe(2);
  });

  it('a parser turns accepted bytes into an emitCues effect', () => {
    const el = document.createElement('video');
    const sink = createTextTrackSink({
      element: el,
      parse: (data, m) => [{ start: m.start, end: m.start + 1, text: `${data.byteLength}b` }],
    });
    const effects = sink.accept('t-de', new ArrayBuffer(16), meta);
    expect(effects).toEqual([
      { kind: 'emitCues', trackId: 't-de', cues: [{ start: 0, end: 1, text: '16b' }] },
    ]);
  });

  it('metadata uses a metadata-kind track through the same machinery', () => {
    const el = document.createElement('video');
    const sink = createMetadataSink({ element: el });
    sink.accept('id3', new ArrayBuffer(4), { ...meta, trackId: 'id3', contentType: 'metadata' });
    sink.handleEmitCues('id3', [{ start: 0, end: 0.1, payload: { key: 'TIT2' } }]);
    expect(sink.nativeTrack('id3')?.kind).toBe('metadata');
    expect(sink.nativeTrack('id3')?.cues?.length).toBe(1);
    expect(sink.contentType).toBe('metadata');
  });
});
