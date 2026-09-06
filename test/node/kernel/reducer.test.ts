import { describe, expect, it } from 'vitest';
import type { Effect, KernelState, SliceReducer } from '../../../src/index.js';
import { createReducer, initialState, isCommand } from '../../../src/kernel/reducer.js';
import { deepFreeze, readyStateWithInflight, vodFixture } from './helpers.js';

const reduce = createReducer();

function frozen(state: KernelState): KernelState {
  return deepFreeze(structuredClone(state));
}

function emptyBuffer(): ArrayBuffer {
  return new ArrayBuffer(8);
}

describe('lifecycle', () => {
  it('walks idle to ready through attach, load, and manifest', () => {
    let state = frozen(initialState());
    let fx: readonly Effect[];

    [state, fx] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    expect(state.lifecycle.phase).toBe('attaching');
    expect(fx).toEqual([]);

    [state, fx] = reduce(frozen(state), { type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
    expect(state.lifecycle.phase).toBe('loading');
    expect(fx).toEqual([
      {
        kind: 'fetch',
        token: 't1:manifest',
        url: 'https://cdn.example/master.m3u8',
        timeout: 10_000,
      },
    ]);

    [state, fx] = reduce(frozen(state), { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(state.lifecycle.phase).toBe('ready');
    expect(state.tracks.available).toEqual(['v', 'a']);
    // The manifest kicks the buffer-goal loop: one fetch per media track.
    expect(state.scheduling.inflight.size).toBe(2);
    expect(fx.map((e) => e.kind)).toContain('setDuration');
  });

  it('rejects ATTACH when already attached, without throwing', () => {
    const attached: KernelState = { ...initialState(), lifecycle: { phase: 'ready' } };
    const [state, fx] = reduce(frozen(attached), {
      type: 'ATTACH',
      element: {} as HTMLMediaElement,
    });
    expect(state.lifecycle.phase).toBe('ready');
    expect(fx).toEqual([
      {
        kind: 'emit',
        event: 'command:rejected',
        payload: { command: 'ATTACH', reason: 'already attached' },
      },
    ]);
  });

  it('rejects LOAD before attach and after a source is loaded', () => {
    const [, idleFx] = reduce(frozen(initialState()), { type: 'LOAD', url: 'u' });
    expect(idleFx[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });

    const [, loadedFx] = reduce(frozen(readyStateWithInflight([])), { type: 'LOAD', url: 'u' });
    expect(loadedFx[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });
  });

  it('DETACH aborts in-flight requests and resets to idle, idempotently', () => {
    const state = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u', sbId: 'sb-v' },
    ]);
    const [next, fx] = reduce(frozen(state), { type: 'DETACH' });
    expect(next.lifecycle.phase).toBe('idle');
    expect(fx).toEqual([{ kind: 'abort', token: 't1' }]);

    const [again, fxAgain] = reduce(frozen(next), { type: 'DETACH' });
    expect(again.lifecycle.phase).toBe('idle');
    expect(fxAgain).toEqual([]);
  });

  it('UNLOAD returns to the attached phase and keeps the token counter', () => {
    const state = readyStateWithInflight([{ token: 't1', trackId: 'v', seq: 0, url: 'u' }]);
    const [next, fx] = reduce(frozen(state), { type: 'UNLOAD' });
    expect(next.lifecycle.phase).toBe('attaching');
    expect(next.presentation).toBeNull();
    expect(next.scheduling.tokenSeq).toBe(state.scheduling.tokenSeq);
    // The MediaSource goes with the source, so the next load starts fresh.
    expect(fx).toEqual([{ kind: 'abort', token: 't1' }, { kind: 'resetSource' }]);
  });

  it('UNLOAD while idle resets nothing on the element', () => {
    const [next, fx] = reduce(frozen(initialState()), { type: 'UNLOAD' });
    expect(next.lifecycle.phase).toBe('idle');
    expect(fx).toEqual([]);
  });
});

describe('seek during in-flight fetch', () => {
  it('aborts the fetch, and the late segment produces no append', () => {
    let state = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u', sbId: 'sb-v' },
    ]);
    let fx: readonly Effect[];

    [state, fx] = reduce(frozen(state), { type: 'SEEK', to: 100 });
    expect(fx).toContainEqual({ kind: 'abort', token: 't1' });
    expect(fx).toContainEqual({ kind: 'seekElement', to: 100 });
    expect(state.scheduling.inflight.size).toBe(0);

    // The fact arrives anyway. It must be absorbed, not rejected.
    [state, fx] = reduce(frozen(state), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 0,
      bytes: emptyBuffer(),
      rtt: 30,
      size: 900,
    });
    expect(fx.filter((e) => e.kind === 'append')).toHaveLength(0);
  });

  it('a late segment for an aborted request never matches the refetch that replaced it', () => {
    // After a quality switch the aborted request and its replacement share
    // track and sequence; only the token tells them apart. The stale bytes
    // belong to another rendition and would decode against the wrong init.
    const state = readyStateWithInflight([
      { token: 't2', trackId: 'v', seq: 0, url: 'u-high', sbId: 'sb-v', renditionId: 'high' },
    ]);
    const [same, staleFx] = reduce(frozen(state), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 0,
      token: 't1',
      bytes: emptyBuffer(),
      rtt: 30,
      size: 900,
    });
    expect(staleFx.filter((e) => e.kind === 'append')).toHaveLength(0);
    expect(same.scheduling.inflight.has('t2')).toBe(true);

    const [, freshFx] = reduce(frozen(same), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 0,
      token: 't2',
      bytes: emptyBuffer(),
      rtt: 30,
      size: 900,
    });
    expect(freshFx.filter((e) => e.kind === 'append')).toHaveLength(1);
  });

  it('a media segment whose rendition is not the one the buffer is initialized for is dropped', () => {
    // A constraint moved the buffer to 'low' (its init landed) while a
    // 'high' segment was still in flight. Appending it would hand the
    // decoder high frames under low parameter sets.
    const base = readyStateWithInflight([
      { token: 't2', trackId: 'v', seq: 3, url: 'u-high', sbId: 'sb-v', renditionId: 'high' },
    ]);
    const state: KernelState = {
      ...base,
      buffers: new Map([
        ['sb-v', { codecs: 'video/mp4', ranges: [], pendingAppends: 0, initFor: 'low' }],
      ]),
    };
    const [next, fx] = reduce(frozen(state), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 3,
      token: 't2',
      bytes: emptyBuffer(),
      rtt: 30,
      size: 900,
    });
    expect(fx.filter((e) => e.kind === 'append')).toHaveLength(0);
    expect(fx).toContainEqual(
      expect.objectContaining({ kind: 'emit', event: 'quality:stale-segment' }),
    );
    expect(next.scheduling.inflight.has('t2')).toBe(false);
  });

  it('rejects SEEK with nothing loaded', () => {
    const [, fx] = reduce(frozen(initialState()), { type: 'SEEK', to: 10 });
    expect(fx[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });
  });
});

describe('segment completion', () => {
  it('appends a matched segment and tracks the pending append', () => {
    const state = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u', sbId: 'sb-v' },
    ]);
    const bytes = emptyBuffer();
    const [next, fx] = reduce(frozen(state), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 0,
      bytes,
      rtt: 100,
      size: 100_000,
    });
    expect(fx[0]).toMatchObject({ kind: 'append', sbId: 'sb-v', data: bytes, seq: 0 });
    expect(next.buffers.get('sb-v')?.pendingAppends).toBe(1);
    // Completion drives the loop; the next fetch may already be in flight.
    expect(next.stats.throughputEwma).toBe(8_000_000);
  });

  it("a segment of a track other than the active rendition's does not sample throughput", () => {
    // An audio segment arrives while video is active: its size says
    // nothing about the video bitrate the chooser is deciding on.
    const base = readyStateWithInflight([
      { token: 'ta', trackId: 'a', seq: 0, url: 'ua', sbId: 'sb-v' },
    ]);
    const state: KernelState = { ...base, quality: { ...base.quality, active: 'v-1' } };
    const before = state.stats.throughputEwma;
    const [next] = reduce(frozen(state), {
      type: 'SEGMENT_LOADED',
      trackId: 'a',
      seq: 0,
      token: 'ta',
      bytes: emptyBuffer(),
      rtt: 100,
      size: 100_000,
    });
    expect(next.stats.throughputEwma).toBe(before);
  });

  it('a manifest with the same track list does not re-emit tracks:changed', () => {
    let state = frozen(initialState());
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(frozen(state), { type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
    let fx: readonly Effect[];
    [state, fx] = reduce(frozen(state), { type: 'MANIFEST_LOADED', presentation: vodFixture });
    const changed = (effects: readonly Effect[]) =>
      effects.filter((e) => e.kind === 'emit' && e.event === 'tracks:changed');
    expect(changed(fx)).toHaveLength(1);
    [, fx] = reduce(frozen(state), { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(changed(fx)).toHaveLength(0);
  });

  it('three consecutive buffer failures trip the breaker: fatal, aborted, halted', () => {
    let state = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u', sbId: 'sb-v' },
    ]);
    const error = {
      category: 'media',
      code: 'MEDIA_APPEND_FAILED',
      fatal: false,
      recoverable: false,
    } as const;
    let fx: readonly Effect[] = [];
    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_ERROR', sbId: 'sb-v', error });
    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_ERROR', sbId: 'sb-v', error });
    expect(state.lifecycle.phase).toBe('ready');
    [state, fx] = reduce(frozen(state), { type: 'SOURCEBUFFER_ERROR', sbId: 'sb-v', error });
    expect(state.lifecycle.phase).toBe('error');
    expect(fx).toContainEqual({ kind: 'abort', token: 't1' });
    expect(state.scheduling.inflight.size).toBe(0);
    // Halted: a driving fact fetches nothing further.
    const [, more] = reduce(frozen(state), {
      type: 'TIME_UPDATE',
      currentTime: 0,
      buffered: [],
    });
    expect(more.filter((e) => e.kind === 'fetch')).toEqual([]);
  });

  it('a successful append resets the breaker', () => {
    let state = readyStateWithInflight([]);
    const error = {
      category: 'media',
      code: 'MEDIA_APPEND_FAILED',
      fatal: false,
      recoverable: false,
    } as const;
    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_ERROR', sbId: 'sb-v', error });
    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_ERROR', sbId: 'sb-v', error });
    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_UPDATEEND', sbId: 'sb-v' });
    expect(state.bufferErrors.has('sb-v')).toBe(false);
    // Two more failures alone stay non-fatal.
    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_ERROR', sbId: 'sb-v', error });
    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_ERROR', sbId: 'sb-v', error });
    expect(state.lifecycle.phase).toBe('ready');
  });

  it('a tiny transfer never enters the throughput averages', () => {
    const state = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u', sbId: 'sb-v' },
    ]);
    const [next] = reduce(frozen(state), {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 0,
      bytes: emptyBuffer(),
      rtt: 100,
      size: 800,
    });
    expect(next.stats.throughputEwma).toBe(0);
    expect(next.stats.throughputFastEwma).toBe(0);
  });

  it('SEGMENT_FAILED clears the request and emits an error event', () => {
    const state = readyStateWithInflight([{ token: 't1', trackId: 'v', seq: 0, url: 'u' }]);
    const [next, fx] = reduce(frozen(state), {
      type: 'SEGMENT_FAILED',
      trackId: 'v',
      seq: 0,
      status: 500,
      error: {
        category: 'network',
        code: 'NETWORK_HTTP_STATUS',
        fatal: false,
        recoverable: true,
      },
    });
    // The failed request is cleared; the error is emitted; and because a
    // failure re-drives scheduling, a replacement fetch for the same track
    // is already in flight (the loop recovers instead of halting silently).
    expect(fx[0]).toMatchObject({ kind: 'emit', event: 'error' });
    const refetch = [...next.scheduling.inflight.values()].find((r) => r.trackId === 'v');
    expect(refetch?.token).not.toBe('t1');
  });
});

describe('facts in the wrong phase are absorbed, never rejected', () => {
  it('absorbs a SOURCEBUFFER_UPDATEEND in idle with no effects', () => {
    const [state, fx] = reduce(frozen(initialState()), {
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId: 'sb-v',
    });
    expect(state).toEqual(initialState());
    expect(fx).toEqual([]);
  });

  it('absorbs an updateend for a buffer removed by a concurrent detach', () => {
    const state = readyStateWithInflight([]);
    const [, fx] = reduce(frozen(state), { type: 'SOURCEBUFFER_UPDATEEND', sbId: 'gone' });
    // The updateend still drives the loop; the point is no error surfaced.
    expect(fx.filter((e) => e.kind === 'emit')).toEqual([]);
  });
});

describe('quota pressure', () => {
  it('emits a remove behind the playhead before any further append', () => {
    const base = readyStateWithInflight([]);
    const state: KernelState = { ...base, playback: { ...base.playback, currentTime: 50 } };
    const [, fx] = reduce(frozen(state), { type: 'QUOTA_EXCEEDED', sbId: 'sb-v' });
    expect(fx).toEqual([{ kind: 'remove', sbId: 'sb-v', start: 0, end: 20 }]);
  });

  it('reports quota exhaustion when nothing is behind the playhead', () => {
    const [, fx] = reduce(frozen(readyStateWithInflight([])), {
      type: 'QUOTA_EXCEEDED',
      sbId: 'sb-v',
    });
    expect(fx).toEqual([{ kind: 'emit', event: 'quota:exhausted', payload: { sbId: 'sb-v' } }]);
  });
});

describe('remaining commands', () => {
  it('SELECT_TRACK activates a known track and rejects an unknown one', () => {
    const state = readyStateWithInflight([]);
    const [next, selectFx] = reduce(frozen(state), { type: 'SELECT_TRACK', trackId: 'a' });
    expect(next.tracks.active.get('audio')).toBe('a');
    expect(selectFx).toContainEqual({
      kind: 'emit',
      event: 'tracks:selected',
      payload: { contentType: 'audio', trackId: 'a' },
    });

    // Re-selecting the active track changes nothing and announces nothing.
    const [, againFx] = reduce(frozen(next), { type: 'SELECT_TRACK', trackId: 'a' });
    expect(againFx.some((e) => e.kind === 'emit' && e.event === 'tracks:selected')).toBe(false);

    const [, fx] = reduce(frozen(state), { type: 'SELECT_TRACK', trackId: 'nope' });
    expect(fx[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });
  });

  it('PIN_RENDITION validates, RELEASE_PIN clears', () => {
    const state = readyStateWithInflight([]);
    const [pinned] = reduce(frozen(state), {
      type: 'PIN_RENDITION',
      renditionId: 'v-1',
      apply: 'soon',
    });
    expect(pinned.quality.pinned).toBe('v-1');

    const [, rejectFx] = reduce(frozen(state), {
      type: 'PIN_RENDITION',
      renditionId: 'v-9',
      apply: 'next',
    });
    expect(rejectFx[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });

    const [released] = reduce(frozen(pinned), { type: 'RELEASE_PIN' });
    expect(released.quality.pinned).toBeNull();
  });

  it('CONSTRAIN and RELEASE_CONSTRAINT maintain the named source map', () => {
    let state = frozen(readyStateWithInflight([]));
    [state] = reduce(state, { type: 'CONSTRAIN', source: 'user', constraint: { maxHeight: 720 } });
    expect(state.quality.constraints.get('user')).toEqual({ maxHeight: 720 });

    const [unchanged] = reduce(frozen(state), { type: 'RELEASE_CONSTRAINT', source: 'ghost' });
    expect(unchanged.quality.constraints.size).toBe(1);

    [state] = reduce(frozen(state), { type: 'RELEASE_CONSTRAINT', source: 'user' });
    expect(state.quality.constraints.size).toBe(0);
  });

  it('SET_BUFFER_GOAL validates its argument', () => {
    const [ok] = reduce(frozen(initialState()), { type: 'SET_BUFFER_GOAL', seconds: 45 });
    expect(ok.scheduling.bufferGoal).toBe(45);

    const [, fx] = reduce(frozen(initialState()), { type: 'SET_BUFFER_GOAL', seconds: -1 });
    expect(fx[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });
  });

  it('ABORT_INFLIGHT scopes to a track when given one', () => {
    const state = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u' },
      { token: 't2', trackId: 'a', seq: 0, url: 'u' },
    ]);
    const [next, fx] = reduce(frozen(state), { type: 'ABORT_INFLIGHT', trackId: 'v' });
    expect(fx).toEqual([{ kind: 'abort', token: 't1' }]);
    expect([...next.scheduling.inflight.keys()]).toEqual(['t2']);
  });

  it('SEEK_TO_LIVE_EDGE rejects on VOD', () => {
    const [, fx] = reduce(frozen(readyStateWithInflight([])), { type: 'SEEK_TO_LIVE_EDGE' });
    expect(fx[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });
  });
});

describe('remaining facts', () => {
  it('tracks playhead and buffered from TIME_UPDATE, SEEKING, and SEEKED', () => {
    let state = frozen(initialState());
    [state] = reduce(state, {
      type: 'TIME_UPDATE',
      currentTime: 12,
      buffered: [{ start: 0, end: 20 }],
    });
    expect(state.playback).toEqual({
      currentTime: 12,
      buffered: [{ start: 0, end: 20 }],
      seeking: false,
    });

    [state] = reduce(frozen(state), { type: 'SEEKING', to: 50 });
    expect(state.playback.seeking).toBe(true);
    expect(state.playback.currentTime).toBe(50);

    [state] = reduce(frozen(state), { type: 'SEEKED', at: 50 });
    expect(state.playback.seeking).toBe(false);
  });

  it('creates and settles SourceBuffer bookkeeping', () => {
    let state = frozen(initialState());
    [state] = reduce(state, { type: 'SOURCEBUFFER_CREATED', sbId: 'sb-a', codecs: 'mp4a.40.2' });
    expect(state.buffers.get('sb-a')).toEqual({
      codecs: 'mp4a.40.2',
      ranges: [],
      pendingAppends: 0,
    });

    [state] = reduce(frozen(state), { type: 'SOURCEBUFFER_UPDATEEND', sbId: 'sb-a' });
    expect(state.buffers.get('sb-a')?.pendingAppends).toBe(0);
  });

  it('fatal errors move the phase to error and emit an error event', () => {
    const error = {
      category: 'manifest',
      code: 'MANIFEST_PARSE_FAILED',
      fatal: true,
      recoverable: false,
    } as const;
    const [failed, fx] = reduce(frozen(initialState()), { type: 'MANIFEST_FAILED', error });
    expect(failed.lifecycle.phase).toBe('error');
    expect(fx[0]).toMatchObject({ kind: 'emit', event: 'error' });

    const [sbFailed] = reduce(frozen(readyStateWithInflight([])), {
      type: 'SOURCEBUFFER_ERROR',
      sbId: 'sb-v',
      error: { ...error, category: 'media', code: 'MEDIA_APPEND_FAILED' },
    });
    expect(sbFailed.lifecycle.phase).toBe('error');
  });

  it('THROUGHPUT_SAMPLE seeds and then smooths the EWMA', () => {
    let state = frozen(initialState());
    [state] = reduce(state, { type: 'THROUGHPUT_SAMPLE', bps: 1_000_000, trackId: 'v' });
    expect(state.stats.throughputEwma).toBe(1_000_000);

    [state] = reduce(frozen(state), { type: 'THROUGHPUT_SAMPLE', bps: 2_000_000, trackId: 'v' });
    expect(state.stats.throughputEwma).toBeCloseTo(1_200_000);
  });

  it('absorbs ELEMENT_ATTACHED, MEDIASOURCE, STALLED, ENCRYPTED, and PLAYLIST_REFRESHED', () => {
    const state = frozen(readyStateWithInflight([]));
    expect(reduce(state, { type: 'ELEMENT_ATTACHED', element: {} as HTMLMediaElement })[1]).toEqual(
      [],
    );
    expect(reduce(state, { type: 'MEDIASOURCE_OPEN' })[1]).toEqual([]);
    expect(reduce(state, { type: 'MEDIASOURCE_CLOSED' })[1]).toEqual([]);
    expect(
      reduce(state, {
        type: 'PLAYLIST_REFRESHED',
        trackId: 'v',
        mediaSequence: 3,
        segments: [],
      })[1],
    ).toEqual([]);
    expect(reduce(state, { type: 'STALLED', at: 4 })[1]).toEqual([
      { kind: 'emit', event: 'playback:stalled', payload: { at: 4 } },
    ]);
    // A stall carrying the element's ranges refreshes the buffered view,
    // which otherwise only timeupdate writes.
    const [stalled] = reduce(state, {
      type: 'STALLED',
      at: 0,
      buffered: [{ start: 1.44, end: 32 }],
    });
    expect(stalled.playback).toEqual({
      currentTime: 0,
      buffered: [{ start: 1.44, end: 32 }],
      seeking: false,
    });
    const initData = new ArrayBuffer(4);
    expect(reduce(state, { type: 'ENCRYPTED', initDataType: 'cenc', initData })[1]).toEqual([
      { kind: 'emit', event: 'drm:encrypted', payload: { initDataType: 'cenc', initData } },
    ]);
  });
});

describe('slice composition', () => {
  it('runs slice reducers with their own slice and merges the result', () => {
    const counter: SliceReducer<number> = (slice, msg) => [
      (slice ?? 0) + (msg.type === 'STALLED' ? 1 : 0),
      [],
    ];
    const reducer = createReducer([['stalls', counter as SliceReducer]]);
    let [state] = reducer(frozen(initialState()), { type: 'STALLED', at: 1 });
    [state] = reducer(frozen(state), { type: 'STALLED', at: 2 });
    expect(state.stalls).toBe(2);
  });

  it('contains a throwing slice reducer and keeps kernel state intact', () => {
    const boom: SliceReducer = () => {
      throw new Error('slice exploded');
    };
    const reducer = createReducer([['boom', boom]]);
    const [state, fx] = reducer(frozen(initialState()), { type: 'STALLED', at: 1 });
    expect(state.lifecycle.phase).toBe('idle');
    expect(state.boom).toBeUndefined();
    expect(fx).toContainEqual({
      kind: 'emit',
      event: 'kernel:slice-error',
      payload: { slice: 'boom', message: 'Error: slice exploded' },
    });
  });
});

describe('configuration', () => {
  it('every default is overridable and the defaults hold otherwise', () => {
    expect(initialState().scheduling.bufferGoal).toBe(30);
    expect(initialState({ bufferGoalSeconds: 60 }).scheduling.bufferGoal).toBe(60);

    const tuned = createReducer([], {
      backBufferSeconds: 5,
      manifestTimeoutMs: 3_000,
      ewmaAlpha: 0.5,
    });

    const base = readyStateWithInflight([]);
    const at30: KernelState = { ...base, playback: { ...base.playback, currentTime: 30 } };
    const [, quotaFx] = tuned(frozen(at30), { type: 'QUOTA_EXCEEDED', sbId: 'sb-v' });
    expect(quotaFx).toEqual([{ kind: 'remove', sbId: 'sb-v', start: 0, end: 25 }]);

    const attached: KernelState = { ...initialState(), lifecycle: { phase: 'attaching' } };
    const [, loadFx] = tuned(frozen(attached), { type: 'LOAD', url: 'u' });
    expect(loadFx).toEqual([{ kind: 'fetch', token: 't1:manifest', url: 'u', timeout: 3_000 }]);

    let [state] = tuned(frozen(initialState()), {
      type: 'THROUGHPUT_SAMPLE',
      bps: 1_000_000,
      trackId: 'v',
    });
    [state] = tuned(frozen(state), { type: 'THROUGHPUT_SAMPLE', bps: 2_000_000, trackId: 'v' });
    expect(state.stats.throughputEwma).toBeCloseTo(1_500_000);
  });
});

describe('purity', () => {
  it('same inputs give deep-equal outputs and the input is never mutated', () => {
    const state = deepFreeze(
      structuredClone(readyStateWithInflight([{ token: 't1', trackId: 'v', seq: 0, url: 'u' }])),
    );
    const msg = { type: 'SEEK', to: 42 } as const;
    const [a, fxA] = reduce(state, msg);
    const [b, fxB] = reduce(state, msg);
    expect(a).toEqual(b);
    expect(fxA).toEqual(fxB);
  });

  it('isCommand discriminates the taxonomy', () => {
    expect(isCommand({ type: 'SEEK', to: 1 })).toBe(true);
    expect(isCommand({ type: 'SEEKED', at: 1 })).toBe(false);
  });
});

describe('manifest acceptance', () => {
  const unsupported = {
    kind: 'emit',
    event: 'error',
    payload: {
      category: 'manifest',
      code: 'MANIFEST_UNSUPPORTED',
      fatal: true,
      recoverable: false,
    },
  };

  function attached(): KernelState {
    const [state] = reduce(frozen(initialState()), {
      type: 'ATTACH',
      element: {} as HTMLMediaElement,
    });
    return state;
  }

  function loading(reducer = reduce): KernelState {
    const [state] = reducer(frozen(attached()), { type: 'LOAD', url: 'https://cdn.example/m' });
    return state;
  }

  function manifestBytes(text: string, token = 't1:manifest') {
    return {
      type: 'SEGMENT_LOADED' as const,
      trackId: 'manifest',
      seq: 0,
      token,
      bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
      rtt: 10,
      size: text.length,
    };
  }

  it('a mimeType outside the composition fails the load before any fetch', () => {
    const typed = createReducer([], undefined, { manifestTypes: new Set(['application/x-foo']) });
    const [state, fx] = typed(frozen(attached()), {
      type: 'LOAD',
      url: 'https://cdn.example/song.mp3',
      mimeType: 'audio/mpeg',
    });
    expect(state.lifecycle.phase).toBe('error');
    expect(state.scheduling.inflight.size).toBe(0);
    expect(fx).toEqual([
      { ...unsupported, payload: { ...unsupported.payload, mimeType: 'audio/mpeg' } },
    ]);
  });

  it('an accepted mimeType fetches, whatever its case and parameters', () => {
    const typed = createReducer([], undefined, { manifestTypes: new Set(['application/x-foo']) });
    const [state, fx] = typed(frozen(attached()), {
      type: 'LOAD',
      url: 'https://cdn.example/m',
      mimeType: 'Application/X-Foo; charset=utf-8',
    });
    expect(state.lifecycle.phase).toBe('loading');
    expect(fx.map((e) => e.kind)).toEqual(['fetch']);
  });

  it('without a manifest type set, a mimeType is passed through and fetched', () => {
    const [state, fx] = reduce(frozen(attached()), {
      type: 'LOAD',
      url: 'https://cdn.example/m',
      mimeType: 'audio/mpeg',
    });
    expect(state.lifecycle.phase).toBe('loading');
    expect(fx.map((e) => e.kind)).toEqual(['fetch']);
  });

  it('manifest bytes no slice acts on are reported as unsupported', () => {
    const [state, fx] = reduce(frozen(loading()), manifestBytes('ID3 '));
    expect(state.lifecycle.phase).toBe('error');
    expect(state.scheduling.inflight.size).toBe(0);
    expect(fx).toEqual([
      { ...unsupported, payload: { ...unsupported.payload, url: 'https://cdn.example/m' } },
    ]);
  });

  it('a slice claims the bytes by acting on them; an event alone is not a claim', () => {
    const feeding: SliceReducer = (slice, msg) =>
      msg.type === 'SEGMENT_LOADED' && msg.trackId === 'manifest'
        ? [
            slice,
            [
              {
                kind: 'schedule',
                token: 'adapter:loopback',
                delayMs: 0,
                // biome-ignore lint/suspicious/noThenProperty: the schedule effect's field
                then: { type: 'MANIFEST_LOADED', presentation: vodFixture },
              },
            ],
          ]
        : [slice, []];
    const claiming = createReducer([['adapter', feeding]]);
    const [claimedState, claimedFx] = claiming(frozen(loading(claiming)), manifestBytes('#EXTM3U'));
    expect(claimedState.lifecycle.phase).toBe('loading');
    expect(claimedFx.map((e) => e.kind)).toEqual(['schedule']);

    const observing: SliceReducer = (slice, msg) =>
      msg.type === 'SEGMENT_LOADED'
        ? [slice, [{ kind: 'emit', event: 'observer:seen', payload: null }]]
        : [slice, []];
    const watching = createReducer([['observer', observing]]);
    const [watchedState, watchedFx] = watching(frozen(loading(watching)), manifestBytes('x'));
    expect(watchedState.lifecycle.phase).toBe('error');
    expect(watchedFx.map((e) => e.kind)).toEqual(['emit', 'emit']);
    expect(watchedFx[1]).toMatchObject(unsupported);
  });

  it('a late manifest response for a request no longer in flight is dropped silently', () => {
    const [state, fx] = reduce(frozen(loading()), manifestBytes('x', 't9:manifest'));
    expect(state.lifecycle.phase).toBe('loading');
    expect(fx).toEqual([]);
  });

  it('a failed manifest fetch is fatal: no retry tick, phase error', () => {
    const [state, fx] = reduce(frozen(loading()), {
      type: 'SEGMENT_FAILED',
      trackId: 'manifest',
      seq: 0,
      status: 404,
      error: { category: 'network', code: 'NETWORK_HTTP_STATUS', fatal: false, recoverable: true },
    });
    expect(state.lifecycle.phase).toBe('error');
    expect(state.scheduling.inflight.size).toBe(0);
    expect(fx).toEqual([
      {
        kind: 'emit',
        event: 'error',
        payload: {
          category: 'network',
          code: 'NETWORK_HTTP_STATUS',
          fatal: true,
          recoverable: false,
          status: 404,
        },
      },
    ]);
  });

  it("the transport's Content-Type refusal surfaces the type it saw", () => {
    const [state, fx] = reduce(frozen(loading()), {
      type: 'SEGMENT_FAILED',
      trackId: 'manifest',
      seq: 0,
      status: 200,
      error: {
        category: 'manifest',
        code: 'MANIFEST_UNSUPPORTED',
        fatal: true,
        recoverable: false,
        context: { url: 'https://cdn.example/m', token: 't1:manifest', contentType: 'audio/mpeg' },
      },
    });
    expect(state.lifecycle.phase).toBe('error');
    expect(fx[0]).toMatchObject({
      kind: 'emit',
      event: 'error',
      payload: { code: 'MANIFEST_UNSUPPORTED', status: 200, contentType: 'audio/mpeg' },
    });
  });
});
