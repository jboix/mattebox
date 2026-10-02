import { afterEach, describe, expect, it } from 'vitest';
import { type CcPacket, deliverCaptions } from '../../../src/containers/captions.js';
import textCea608 from '../../../src/stages/text-cea608/index.js';
import textCea708 from '../../../src/stages/text-cea708/index.js';
import type { Presentation, Track } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';
import type { StageContext } from '../../../src/types/stage.js';

/**
 * text-cea708 makes each CEA-708 service a caption track beside the 608
 * channels. A stub context scripts the kernel's part; the element and its
 * TextTrackList are real.
 */

const DECLARED: Track = {
  id: 'cc:708',
  contentType: 'text',
  mimeType: 'application/cea-708',
  protection: null,
  lang: 'en',
  role: 'caption',
  instreamId: 'SERVICE1',
  renditions: [],
};

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function install(tracks: readonly Track[]) {
  const element = document.createElement('video');
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const h = {
    element,
    dispatched: [] as Command[],
    presentation: {
      id: 'p',
      isLive: false,
      duration: 60,
      periods: [{ id: 'p0', start: 0, tracks: [...tracks] }],
      couplings: [],
    } as Presentation,
    active: new Map<string, string>(),
    emit(event: string, payload: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
  };
  const ctx = {
    element,
    getState: () =>
      ({
        presentation: h.presentation,
        tracks: { active: h.active, available: [] },
      }) as unknown as KernelState,
    dispatch(cmd: Command) {
      h.dispatched.push(cmd);
      if (cmd.type === 'SELECT_TRACK') {
        h.active = new Map([['text', cmd.trackId]]);
        h.emit('tracks:selected', { contentType: 'text', trackId: cmd.trackId });
      } else if (cmd.type === 'ADD_TRACK') {
        const [period] = h.presentation.periods;
        h.presentation = {
          ...h.presentation,
          periods: [
            {
              ...(period as Presentation['periods'][number]),
              tracks: [...(period?.tracks ?? []), cmd.track],
            },
          ],
        };
        h.emit('tracks:changed', {});
      }
    },
    on(event: string, fn: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => {};
    },
  } as unknown as StageContext;
  for (const stage of [textCea608, textCea708]) {
    const teardown = stage().install(ctx);
    if (typeof teardown === 'function') teardowns.push(teardown);
  }
  h.emit('tracks:changed', {});
  return h;
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** One DTVCC packet holding one service block, as cc_data triples at `time`. */
function packet(service: number, data: number[], time: number, sequence = 0): CcPacket {
  const bytes = [(service << 5) | data.length, ...data];
  if (bytes.length % 2 === 0) bytes.push(0);
  const triples = [
    { type: 3, a: (sequence << 6) | ((bytes.length + 1) / 2), b: bytes[0] as number },
  ];
  for (let i = 1; i < bytes.length; i += 2)
    triples.push({ type: 2, a: bytes[i] as number, b: bytes[i + 1] as number });
  return { time, triples };
}

/** A visible window 0 anchored bottom center at 90 % down, with `text`, shown from `start` to `end`. */
function caption(service: number, text: string, start: number, end: number): void {
  const define = [0x98, 0x20, 0x80 | 90, 50, (7 << 4) | 0, 31, (3 << 3) | 1];
  deliverCaptions([
    packet(service, [...define, ...ascii(text)], start, 0),
    packet(service, [0x0c], end, 1),
  ]);
}

function nativeTrack(element: HTMLVideoElement, label: string): TextTrack | undefined {
  return [...element.textTracks].find((t) => t.kind === 'captions' && t.label === label);
}

describe('text-cea708 makes each service a caption track', () => {
  it('adds an undeclared service on its first cue and places the cue where its window sits', () => {
    const h = install([]);
    caption(2, 'Hola', 1, 3);
    expect(h.dispatched).toContainEqual(
      expect.objectContaining({
        type: 'ADD_TRACK',
        track: expect.objectContaining({ id: 'cea708:SERVICE2', instreamId: 'SERVICE2' }),
      }),
    );
    const native = nativeTrack(h.element, 'SERVICE2');
    expect(native?.mode).toBe('hidden');
    const cue = native?.cues?.[0] as VTTCue | undefined;
    expect([cue?.startTime, cue?.endTime, cue?.text]).toEqual([1, 3, 'Hola']);
    expect(cue?.snapToLines).toBe(false);
    expect(cue?.line).toBe(90);
    expect(cue?.position).toBe(50);
    // Window style 3 centers its text.
    expect(cue?.align).toBe('center');
    expect((cue as unknown as { cea708: { anchorPoint: number } }).cea708.anchorPoint).toBe(7);
  });

  it('shows the declared service while it is selected, beside the 608 channels', () => {
    const h = install([DECLARED]);
    h.active = new Map([['text', 'cc:708']]);
    h.emit('tracks:selected', { contentType: 'text', trackId: 'cc:708' });
    expect(nativeTrack(h.element, 'SERVICE1')?.mode).toBe('showing');
    caption(1, 'Hello', 0, 2);
    expect(h.dispatched.filter((c) => c.type === 'ADD_TRACK')).toEqual([]);
    // A 608 pop-on on CC1 in the same batch reaches text-cea608.
    deliverCaptions([
      { time: 4, triples: [{ type: 0, a: 0x14, b: 0x20 }] },
      { time: 4, triples: [{ type: 0, a: 0x14, b: 0x40 }] },
      { time: 4, triples: [{ type: 0, a: 0x48, b: 0x49 }] },
      { time: 4, triples: [{ type: 0, a: 0x14, b: 0x2f }] },
      { time: 6, triples: [{ type: 0, a: 0x14, b: 0x2c }] },
    ]);
    expect(nativeTrack(h.element, 'SERVICE1')?.cues?.length).toBe(1);
    expect(nativeTrack(h.element, 'CC1')?.cues?.length).toBe(1);
  });
});
