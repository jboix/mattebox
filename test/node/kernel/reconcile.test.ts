import { describe, expect, it } from 'vitest';
import type { Effect, KernelState } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { deepFreeze, vodFixture } from './helpers.js';

// The Apple VOD case: both playlists start at zero, the media clocks near
// ten seconds, video a little later than audio (its first frame is a
// B-frame's worth after the audio priming).
const VIDEO_START = 9.958;
const AUDIO_START = 9.904;

function ready(reduce: ReturnType<typeof createReducer>): {
  state: KernelState;
  effects: readonly Effect[];
} {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
  const [loaded, effects] = reduce(state, { type: 'MANIFEST_LOADED', presentation: vodFixture });
  // The buffers the manifest asked for exist, so appends are tracked and
  // an updateend can release the next fetch.
  state = loaded;
  for (const sbId of ['sb:video', 'sb:audio']) {
    [state] = reduce(state, { type: 'SOURCEBUFFER_CREATED', sbId, codecs: 'x' });
  }
  return { state, effects };
}

function fetches(effects: readonly Effect[]): string[] {
  return effects.flatMap((e) => (e.kind === 'fetch' ? [e.token] : []));
}

function landed(
  reduce: ReturnType<typeof createReducer>,
  state: KernelState,
  token: string,
  mediaStart?: number,
): readonly [KernelState, readonly Effect[]] {
  const request = state.scheduling.inflight.get(token);
  if (request === undefined) throw new Error(`no request ${token}`);
  return reduce(deepFreeze(structuredClone(state)), {
    type: 'SEGMENT_LOADED',
    trackId: request.trackId,
    seq: request.seq,
    token,
    bytes: new ArrayBuffer(8),
    rtt: 10,
    size: 8,
    ...(mediaStart !== undefined ? { mediaStart } : {}),
  });
}

describe('epoch reconciliation from the bytes', () => {
  it('with a probe, the lead fetches first and its decode time settles the offset for every buffer', () => {
    const reduce = createReducer([], undefined, { timeProbe: () => null });
    const { state, effects } = ready(reduce);
    // Audio holds until the video segment has settled the epoch.
    expect(fetches(effects)).toEqual(['t2:v:0']);
    expect(state.scheduling.inflight.get('t2:v:0')).toMatchObject({ epoch: 'p0' });

    const [afterVideo, videoFx] = landed(reduce, state, 't2:v:0', VIDEO_START);
    expect(videoFx.slice(0, 2)).toMatchObject([
      { kind: 'setTimestampOffset', sbId: 'sb:video', offset: -VIDEO_START },
      { kind: 'append', sbId: 'sb:video' },
    ]);
    expect(afterVideo.timeline.reconciled.get('p0')).toBe(-VIDEO_START);
    // The settled epoch releases audio on the way out.
    const audioToken = fetches(videoFx).find((t) => t.includes(':a:'));
    expect(audioToken).toBeDefined();

    // Audio applies the video's offset, not its own reading: one offset
    // per timeline keeps the tracks aligned as their shared clock had them.
    const [afterAudio, audioFx] = landed(reduce, afterVideo, audioToken as string, AUDIO_START);
    expect(audioFx.slice(0, 2)).toMatchObject([
      { kind: 'setTimestampOffset', sbId: 'sb:audio', offset: -VIDEO_START },
      { kind: 'append', sbId: 'sb:audio' },
    ]);
    expect(afterAudio.timeline.periodOffsets.get('sb:audio')).toBe(-VIDEO_START);
  });

  it('a later segment of a settled epoch changes nothing, whatever its own reading says', () => {
    const reduce = createReducer([], undefined, { timeProbe: () => null });
    const { state } = ready(reduce);
    const [afterFirst] = landed(reduce, state, 't2:v:0', VIDEO_START);
    // The append completes and the buffer holds the first segment.
    const [drained, drainFx] = reduce(afterFirst, {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb:video',
      ranges: [{ start: 0, end: 4 }],
    });
    const next = fetches(drainFx).find((t) => t.includes(':v:1'));
    expect(next).toBeDefined();
    const [afterSecond, secondFx] = landed(reduce, drained, next as string, VIDEO_START + 4.01);
    expect(secondFx.some((e) => e.kind === 'setTimestampOffset')).toBe(false);
    expect(afterSecond.timeline.reconciled.get('p0')).toBe(-VIDEO_START);
  });

  it('without a reading the manifest prediction settles the epoch, so nothing waits twice', () => {
    const reduce = createReducer([], undefined, { timeProbe: () => null });
    const { state } = ready(reduce);
    const [after, fx] = landed(reduce, state, 't2:v:0');
    expect(fx[0]).toMatchObject({ kind: 'setTimestampOffset', sbId: 'sb:video', offset: 0 });
    expect(after.timeline.reconciled.get('p0')).toBe(0);
    expect(fetches(fx).some((t) => t.includes(':a:'))).toBe(true);
  });

  it('without a probe every track fetches at once and the prediction stands', () => {
    const reduce = createReducer();
    const { state, effects } = ready(reduce);
    expect(fetches(effects)).toEqual(['t2:v:0', 't3:a:0']);
    const [, fx] = landed(reduce, state, 't3:a:0');
    expect(fx[0]).toMatchObject({ kind: 'setTimestampOffset', sbId: 'sb:audio', offset: 0 });
  });

  it('UNLOAD forgets the settled epochs with the presentation', () => {
    const reduce = createReducer([], undefined, { timeProbe: () => null });
    const { state } = ready(reduce);
    const [after] = landed(reduce, state, 't2:v:0', VIDEO_START);
    const [unloaded] = reduce(after, { type: 'UNLOAD' });
    expect(unloaded.timeline.reconciled.size).toBe(0);
  });
});
