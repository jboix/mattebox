/**
 * Text as a peer media pipeline: cues go to a native TextTrack, because the
 * browser's renderer, styling, and caption UI come free. This sink accepts
 * segment bytes like any other sink; turning bytes into cues is a parser's
 * job (text-webvtt, Stage 12), so without a registered parser a segment is
 * consumed but yields no cues.
 */
import type { ContentType, TimeRange, TimeRangesSnapshot, TrackId } from '../../types/ir.js';
import type { CueDescriptor, Effect } from '../../types/messages.js';
import type { Sink } from '../../types/sink.js';
import type { ParserFn } from '../../types/stage.js';

export type CueContentType = Extract<ContentType, 'text' | 'metadata'>;

export interface CueSinkDeps {
  readonly element: HTMLMediaElement;
  /** bytes to cues. Absent until a text stage registers one. */
  readonly parse?: ParserFn;
  /** TextTrack label prefix, visible in browser UIs. */
  readonly label?: string;
}

export interface CueSink<C extends CueContentType> extends Sink<C> {
  /** The handler for the emitCues effect. Register with the effect runner. */
  handleEmitCues(trackId: TrackId, cues: readonly CueDescriptor[]): void;
  /**
   * Creates the native track for a trackId ahead of any segment, so the
   * browser's caption menu lists it before it is ever selected. Idempotent;
   * returns the native track either way.
   */
  declare(trackId: TrackId): TextTrack;
  /** The native track backing a trackId, for tests and track UIs. */
  nativeTrack(trackId: TrackId): TextTrack | null;
  /** Every trackId with a native track. */
  trackIds(): readonly TrackId[];
  /**
   * Releases one track: its cues go, its mode ends disabled, and the sink
   * forgets it. The native track itself stays on the element, empty, since
   * the element has no way to remove one; a later declare adopts it.
   */
  retire(trackId: TrackId): void;
  /** Retires every track. The teardown path; idempotent. */
  dispose(): void;
}

interface TrackEntry {
  readonly textTrack: TextTrack;
  coverage: TimeRange[];
  readonly ids: Set<string>;
}

/** Applies the WebVTT settings string's known keys onto a native cue. */
function applySettings(cue: VTTCue, settings: string | undefined): void {
  if (settings === undefined) return;
  for (const part of settings.split(/\s+/)) {
    const [key, value] = part.split(':');
    if (value === undefined) continue;
    const percent = value.endsWith('%') ? Number(value.slice(0, -1)) : null;
    switch (key) {
      case 'line':
        cue.line = percent ?? Number(value);
        if (percent !== null) cue.snapToLines = false;
        break;
      case 'position':
        if (percent !== null) cue.position = percent;
        break;
      case 'size':
        if (percent !== null) cue.size = percent;
        break;
      case 'align':
        cue.align = value as AlignSetting;
        break;
      case 'vertical':
        cue.vertical = value as DirectionSetting;
        break;
      default:
        break;
    }
  }
}

function mergeRange(coverage: TimeRange[], added: TimeRange): TimeRange[] {
  const merged: TimeRange[] = [];
  let pending = added;
  for (const range of [...coverage].sort((a, b) => a.start - b.start)) {
    if (range.end < pending.start || range.start > pending.end) {
      merged.push(range);
    } else {
      pending = {
        start: Math.min(range.start, pending.start),
        end: Math.max(range.end, pending.end),
      };
    }
  }
  merged.push(pending);
  return merged.sort((a, b) => a.start - b.start);
}

export function createCueSink<C extends CueContentType>(
  contentType: C,
  kind: TextTrackKind,
  deps: CueSinkDeps,
): CueSink<C> {
  const tracks = new Map<TrackId, TrackEntry>();

  /**
   * A native track for the id. The element has no removeTextTrack, so a
   * previous attach on the same element (a rebuild, an element swap back)
   * leaves its tracks behind; one with our kind and label is adopted and
   * emptied rather than duplicated in the browser's caption menu.
   */
  /** Empties a native track. `cues` reads null while disabled; hidden makes them removable. */
  function empty(textTrack: TextTrack): void {
    textTrack.mode = 'hidden';
    const { cues } = textTrack;
    if (cues !== null) {
      for (let i = cues.length - 1; i >= 0; i -= 1) {
        const cue = cues[i];
        if (cue !== undefined) textTrack.removeCue(cue);
      }
    }
  }

  function adopt(label: string): TextTrack {
    for (const existing of deps.element.textTracks) {
      if (existing.kind !== kind || existing.label !== label) continue;
      empty(existing);
      return existing;
    }
    return deps.element.addTextTrack(kind, label);
  }

  function retire(trackId: TrackId): void {
    const entry = tracks.get(trackId);
    if (entry === undefined) return;
    empty(entry.textTrack);
    entry.textTrack.mode = 'disabled';
    tracks.delete(trackId);
  }

  function ensure(trackId: TrackId): TrackEntry {
    let entry = tracks.get(trackId);
    if (entry === undefined) {
      const textTrack = adopt(`${deps.label ?? 'mattebox'}:${trackId}`);
      textTrack.mode = 'hidden';
      entry = { textTrack, coverage: [], ids: new Set() };
      tracks.set(trackId, entry);
    }
    return entry;
  }

  return {
    contentType,
    accept(trackId, data, meta): readonly Effect[] {
      const entry = ensure(trackId);
      if (!meta.isInit) {
        entry.coverage = mergeRange(entry.coverage, {
          start: meta.start,
          end: meta.start + meta.duration,
        });
      }
      if (deps.parse === undefined) return [];
      const cues = deps.parse(new Uint8Array(data), meta);
      if (cues.length === 0) return [];
      return [{ kind: 'emitCues', trackId, cues }];
    },
    ranges(trackId): TimeRangesSnapshot {
      return tracks.get(trackId)?.coverage ?? [];
    },
    clear(trackId, start, end): readonly Effect[] {
      // Cue removal has no effect kind: unlike appendBuffer it needs no
      // serialization against a hardware pipeline, so it happens here, and
      // the returned effect list is empty by design.
      const entry = tracks.get(trackId);
      if (entry === undefined) return [];
      const { cues } = entry.textTrack;
      if (cues !== null) {
        for (let i = cues.length - 1; i >= 0; i -= 1) {
          const cue = cues[i];
          if (cue !== undefined && cue.startTime >= start && cue.endTime <= end) {
            entry.textTrack.removeCue(cue);
            if (cue.id !== '') entry.ids.delete(cue.id);
          }
        }
      }
      entry.coverage = entry.coverage.flatMap((range) => {
        if (range.end <= start || range.start >= end) return [range];
        const kept: TimeRange[] = [];
        if (range.start < start) kept.push({ start: range.start, end: start });
        if (range.end > end) kept.push({ start: end, end: range.end });
        return kept;
      });
      return [];
    },
    handleEmitCues(trackId, cues) {
      const entry = ensure(trackId);
      for (const cue of cues) {
        // Re-delivered segments re-emit their cues; identity dedups them.
        if (cue.id !== undefined && entry.ids.has(cue.id)) continue;
        const vtt = new VTTCue(cue.start, cue.end, cue.text ?? '');
        if (cue.id !== undefined) {
          vtt.id = cue.id;
          entry.ids.add(cue.id);
        }
        applySettings(vtt, cue.settings);
        entry.textTrack.addCue(vtt);
      }
    },
    declare(trackId) {
      return ensure(trackId).textTrack;
    },
    nativeTrack(trackId) {
      return tracks.get(trackId)?.textTrack ?? null;
    },
    trackIds() {
      return [...tracks.keys()];
    },
    retire,
    dispose() {
      for (const trackId of [...tracks.keys()]) retire(trackId);
    },
  };
}

/** Subtitles and captions to a native TextTrack. */
export function createTextTrackSink(deps: CueSinkDeps): CueSink<'text'> {
  return createCueSink('text', 'subtitles', deps);
}
