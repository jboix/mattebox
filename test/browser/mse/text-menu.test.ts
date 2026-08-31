import { describe, expect, it } from 'vitest';
import textWebvtt from '../../../src/stages/text-webvtt/index.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';
import type { StageContext } from '../../../src/types/stage.js';

/**
 * The text-webvtt stage keeps the element's TextTrackList and the engine's
 * text selection in step. This drives the stage through a stub context: the
 * kernel's part (events, state) is scripted, the element is real.
 */

const presentation: Presentation = {
  id: 'p',
  isLive: false,
  duration: 60,
  periods: [
    {
      id: 'p0',
      start: 0,
      tracks: [
        { id: 'v', contentType: 'video', mimeType: 'video/mp4', protection: null, renditions: [] },
        {
          id: 'subs:en',
          contentType: 'text',
          mimeType: 'text/vtt',
          lang: 'en',
          protection: null,
          renditions: [],
        },
        {
          id: 'subs:de',
          contentType: 'text',
          mimeType: 'text/vtt',
          lang: 'de',
          protection: null,
          renditions: [],
        },
      ],
    },
  ],
  couplings: [],
};

interface Harness {
  readonly element: HTMLVideoElement;
  presentation: Presentation;
  readonly dispatched: Command[];
  readonly listeners: Map<string, Array<(payload: unknown) => void>>;
  active: Map<string, string>;
  emit(event: string, payload: unknown): void;
  teardown(): void;
}

function install(): Harness {
  const element = document.createElement('video');
  const dispatched: Command[] = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const harness: Harness = {
    element,
    dispatched,
    listeners,
    active: new Map(),
    presentation,
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
    teardown: () => {},
  };
  const ctx = {
    element,
    registerSink() {},
    registerParser() {},
    getState: () =>
      ({
        presentation: harness.presentation,
        tracks: { active: harness.active, available: [] },
      }) as unknown as KernelState,
    dispatch(cmd: Command) {
      dispatched.push(cmd);
      // Mirror what the kernel would do, so a mirror after the dispatch
      // finds the element already in step.
      if (cmd.type === 'SELECT_TRACK') harness.active = new Map([['text', cmd.trackId]]);
      if (cmd.type === 'DESELECT_TRACK') harness.active = new Map();
    },
    on(event: string, fn: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => {};
    },
  } as unknown as StageContext;
  const returned = textWebvtt().install(ctx);
  if (typeof returned === 'function') harness.teardown = returned;
  return harness;
}

function native(el: HTMLVideoElement, label: string): TextTrack {
  for (const track of el.textTracks) {
    if (track.label.endsWith(`:${label}`)) return track;
  }
  throw new Error(`no native track for ${label}`);
}

/** The TextTrackList `change` event is async; wait a turn for it. */
function changed(el: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    el.textTracks.addEventListener('change', () => resolve(), { once: true });
  });
}

describe('text-webvtt keeps the caption menu and the engine in step', () => {
  it('declares every text track natively as disabled when the manifest lands', () => {
    const h = install();
    h.emit('tracks:changed', { available: [] });
    expect(h.element.textTracks.length).toBe(2);
    expect(native(h.element, 'subs:en').mode).toBe('disabled');
    expect(native(h.element, 'subs:de').mode).toBe('disabled');
    expect(h.dispatched).toEqual([]);
  });

  it('an engine selection shows that track and disables the rest', async () => {
    const h = install();
    h.emit('tracks:changed', { available: [] });
    h.active = new Map([['text', 'subs:de']]);
    h.emit('tracks:selected', { contentType: 'text', trackId: 'subs:de' });
    expect(native(h.element, 'subs:de').mode).toBe('showing');
    expect(native(h.element, 'subs:en').mode).toBe('disabled');
    // The mirror's own writes fire `change`; nothing is dispatched for them.
    await changed(h.element);
    expect(h.dispatched).toEqual([]);
  });

  it('a pick in the native menu selects in the engine; off deselects', async () => {
    const h = install();
    h.emit('tracks:changed', { available: [] });

    native(h.element, 'subs:en').mode = 'showing';
    await changed(h.element);
    expect(h.dispatched).toEqual([{ type: 'SELECT_TRACK', trackId: 'subs:en' }]);

    native(h.element, 'subs:en').mode = 'disabled';
    await changed(h.element);
    expect(h.dispatched[1]).toEqual({ type: 'DESELECT_TRACK', contentType: 'text' });
  });

  it('teardown stops listening to the element and switches its tracks off, emptied', async () => {
    const h = install();
    h.emit('tracks:changed', { available: [] });
    h.active = new Map([['text', 'subs:en']]);
    h.emit('tracks:selected', { contentType: 'text', trackId: 'subs:en' });
    const en = native(h.element, 'subs:en');
    en.addCue(new VTTCue(0, 60, 'the last subtitle'));
    expect(en.mode).toBe('showing');

    h.teardown();
    expect(en.mode).toBe('disabled');
    en.mode = 'hidden';
    expect(en.cues?.length).toBe(0);

    en.mode = 'showing';
    await changed(h.element);
    expect(h.dispatched).toEqual([]);
  });

  it('a track that left the presentation is retired on the next tracks:changed', () => {
    const h = install();
    h.emit('tracks:changed', { available: [] });
    h.active = new Map([['text', 'subs:de']]);
    h.emit('tracks:selected', { contentType: 'text', trackId: 'subs:de' });
    const de = native(h.element, 'subs:de');
    de.addCue(new VTTCue(0, 60, 'tschüss'));

    h.presentation = { ...presentation, periods: [] };
    h.active = new Map();
    h.emit('tracks:changed', { available: [] });
    expect(de.mode).toBe('disabled');
    de.mode = 'hidden';
    expect(de.cues?.length).toBe(0);
  });
});
