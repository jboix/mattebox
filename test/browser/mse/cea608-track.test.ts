import { afterEach, describe, expect, it } from 'vitest';
import { deliverCaptions } from '../../../src/containers/captions.js';
import textCea608 from '../../../src/stages/text-cea608/index.js';
import textWebvtt from '../../../src/stages/text-webvtt/index.js';
import type { Presentation, Track } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';
import type { Stage, StageContext } from '../../../src/types/stage.js';

/**
 * text-cea608 makes in-band captions a text track like any subtitle. This
 * drives the stage through a stub context: the kernel's part (state, track
 * commands, events) is scripted, the element and its TextTrackList are real.
 */

const DECLARED: Track = {
  id: 'cc:English',
  contentType: 'text',
  mimeType: 'application/cea-608',
  protection: null,
  lang: 'en',
  role: 'caption',
  instreamId: 'CC1',
  renditions: [],
};
const SUBS: Track = {
  id: 'subs:en',
  contentType: 'text',
  mimeType: 'text/vtt',
  protection: null,
  lang: 'en',
  renditions: [],
};

interface Harness {
  readonly element: HTMLVideoElement;
  readonly dispatched: Command[];
  presentation: Presentation;
  active: Map<string, string>;
  emit(event: string, payload: unknown): void;
}

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function install(tracks: readonly Track[], stages: Array<() => Stage> = [textCea608]): Harness {
  const element = document.createElement('video');
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const harness: Harness = {
    element,
    dispatched: [],
    presentation: {
      id: 'p',
      isLive: false,
      duration: 60,
      periods: [{ id: 'p0', start: 0, tracks: [...tracks] }],
      couplings: [],
    },
    active: new Map(),
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
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
    // The kernel's part: apply the track commands, then report them.
    dispatch(cmd: Command) {
      harness.dispatched.push(cmd);
      if (cmd.type === 'SELECT_TRACK') {
        harness.active = new Map([['text', cmd.trackId]]);
        harness.emit('tracks:selected', { contentType: 'text', trackId: cmd.trackId });
      } else if (cmd.type === 'DESELECT_TRACK') {
        harness.active = new Map();
        harness.emit('tracks:selected', { contentType: 'text', trackId: null });
      } else if (cmd.type === 'ADD_TRACK') {
        const [period] = harness.presentation.periods;
        harness.presentation = {
          ...harness.presentation,
          periods: [
            {
              ...(period as Presentation['periods'][number]),
              tracks: [...(period?.tracks ?? []), cmd.track],
            },
          ],
        };
        harness.emit('tracks:changed', {});
      }
    },
    on(event: string, fn: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => {};
    },
  } as unknown as StageContext;
  for (const stage of stages) {
    const teardown = stage().install(ctx);
    if (typeof teardown === 'function') teardowns.push(teardown);
  }
  harness.emit('tracks:changed', {});
  return harness;
}

function caption(element: HTMLVideoElement): TextTrack | undefined {
  return [...element.textTracks].find((t) => t.kind === 'captions' && t.label === 'CC1');
}

/** The TextTrackList `change` event is async; wait a turn for it. */
function changed(el: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    el.textTracks.addEventListener('change', () => resolve(), { once: true });
  });
}

/** A pop-on caption "HI" shown from `start` to `end`, as CC1 byte pairs. */
function popOn(start: number, end: number): void {
  const pair = (a: number, b: number, time: number) => ({ time, triples: [{ type: 0, a, b }] });
  deliverCaptions([
    pair(0x14, 0x20, start), // resume caption loading
    pair(0x14, 0x40, start), // row preamble
    pair(0x48, 0x49, start), // "HI"
    pair(0x14, 0x2f, start), // end of caption: shows it
    pair(0x14, 0x2c, end), // erase displayed memory: ends it
  ]);
}

describe('text-cea608 makes in-band captions a selectable text track', () => {
  it('shows the declared caption track while it is selected', () => {
    const h = install([DECLARED]);
    h.active = new Map([['text', 'cc:English']]);
    h.emit('tracks:selected', { contentType: 'text', trackId: 'cc:English' });
    expect(caption(h.element)?.mode).toBe('showing');
    expect(caption(h.element)?.language).toBe('en');
    h.active = new Map();
    h.emit('tracks:selected', { contentType: 'text', trackId: null });
    // Hidden, not disabled: cues keep arriving for the next selection.
    expect(caption(h.element)?.mode).toBe('hidden');
  });

  it('a pick in the native menu selects the caption track; off deselects', async () => {
    const h = install([DECLARED]);
    popOn(1, 3);
    const native = caption(h.element) as TextTrack;
    native.mode = 'showing';
    await changed(h.element);
    expect(h.dispatched).toEqual([{ type: 'SELECT_TRACK', trackId: 'cc:English' }]);
    native.mode = 'hidden';
    await changed(h.element);
    expect(h.dispatched.at(-1)).toEqual({ type: 'DESELECT_TRACK', contentType: 'text' });
  });

  it('adds a caption track on the first cue of a stream that declares none', () => {
    const h = install([SUBS]);
    popOn(1, 3);
    popOn(5, 7);
    const adds = h.dispatched.filter((cmd) => cmd.type === 'ADD_TRACK');
    expect(adds).toEqual([
      {
        type: 'ADD_TRACK',
        track: {
          id: 'cea608:CC1',
          contentType: 'text',
          mimeType: 'application/cea-608',
          protection: null,
          role: 'caption',
          instreamId: 'CC1',
          renditions: [],
        },
      },
    ]);
    // Hidden until selected; the cues are there.
    expect(caption(h.element)?.mode).toBe('hidden');
    expect(caption(h.element)?.cues?.length).toBe(2);
  });

  it('with text-webvtt: selecting captions leaves the WebVTT track off, and back', async () => {
    const h = install([SUBS, DECLARED], [textWebvtt, textCea608]);
    h.dispatched.length = 0;
    // The caption track is not a WebVTT track: text-webvtt makes no native track for it.
    expect([...h.element.textTracks].map((t) => t.label)).toEqual(['mattebox:subs:en']);
    h.active = new Map([['text', 'cc:English']]);
    h.emit('tracks:selected', { contentType: 'text', trackId: 'cc:English' });
    await changed(h.element);
    expect(caption(h.element)?.mode).toBe('showing');
    // text-webvtt saw none of its tracks showing and did not deselect the captions.
    expect(h.dispatched).toEqual([]);
    h.active = new Map([['text', 'subs:en']]);
    h.emit('tracks:selected', { contentType: 'text', trackId: 'subs:en' });
    await changed(h.element);
    expect(caption(h.element)?.mode).toBe('hidden');
    expect(h.dispatched).toEqual([]);
  });
});
