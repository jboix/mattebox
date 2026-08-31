import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '../../../src/index.js';
import { createBus } from '../../../src/kernel/bus.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { createTraceBuffer, digest, exportTrace, replay } from '../../../src/kernel/trace.js';
import { readyStateWithInflight } from './helpers.js';

function entry(at: number): TraceEntry {
  return { t: at, msg: { type: 'STALLED', at }, effects: [], digest: 'd' };
}

describe('trace buffer', () => {
  it('keeps insertion order below capacity', () => {
    const buffer = createTraceBuffer(3);
    buffer.push(entry(1));
    buffer.push(entry(2));
    expect(buffer.snapshot().map((e) => e.t)).toEqual([1, 2]);
  });

  it('wraps at capacity, overwriting the oldest', () => {
    const buffer = createTraceBuffer(3);
    for (let at = 1; at <= 7; at += 1) buffer.push(entry(at));
    expect(buffer.snapshot().map((e) => e.t)).toEqual([5, 6, 7]);
  });
});

describe('digest', () => {
  it('is stable for equal states and differs when relevant state changes', () => {
    const a = readyStateWithInflight([]);
    const b = readyStateWithInflight([]);
    expect(digest(a)).toBe(digest(b));

    const moved = { ...a, playback: { ...a.playback, currentTime: 9 } };
    expect(digest(moved)).not.toBe(digest(a));
    expect(digest(a)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('does not depend on Map insertion order', () => {
    const a = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u' },
      { token: 't2', trackId: 'a', seq: 0, url: 'u' },
    ]);
    const b = readyStateWithInflight([
      { token: 't2', trackId: 'a', seq: 0, url: 'u' },
      { token: 't1', trackId: 'v', seq: 0, url: 'u' },
    ]);
    expect(digest(a)).toBe(digest(b));
  });
});

describe('exportTrace', () => {
  it('produces JSON with byte payloads and opaque objects reduced', () => {
    const entries: TraceEntry[] = [
      {
        t: 1,
        msg: {
          type: 'SEGMENT_LOADED',
          trackId: 'v',
          seq: 0,
          bytes: new ArrayBuffer(1024),
          rtt: 30,
          size: 1024,
        },
        effects: [{ kind: 'append', sbId: 'sb-v', data: new ArrayBuffer(1024) }],
        digest: 'abcd1234',
      },
    ];
    const parsed = JSON.parse(exportTrace(entries));
    expect(parsed[0].msg.bytes).toEqual({ $bytes: 1024 });
    expect(parsed[0].effects[0].data).toEqual({ $bytes: 1024 });
  });

  it('tags non-plain objects instead of serializing them', () => {
    class Opaque {}
    const entries: TraceEntry[] = [
      {
        t: 1,
        msg: { type: 'ELEMENT_ATTACHED', element: new Opaque() as unknown as HTMLMediaElement },
        effects: [],
        digest: 'd',
      },
    ];
    const parsed = JSON.parse(exportTrace(entries));
    expect(parsed[0].msg.element).toEqual({ $opaque: 'Opaque' });
  });
});

describe('replay', () => {
  function record(): readonly TraceEntry[] {
    const bus = createBus({ reducer: createReducer(), initial: initialState(), now: () => 0 });
    bus.dispatch({ type: 'ATTACH', element: {} as HTMLMediaElement });
    bus.dispatch({ type: 'LOAD', url: 'https://cdn.example/master.m3u8' });
    bus.dispatch({ type: 'SET_BUFFER_GOAL', seconds: 45 });
    bus.absorb({ type: 'STALLED', at: 2 });
    bus.dispatch({ type: 'SEEK', to: 30 });
    return bus.trace();
  }

  it('reproduces identical effects from a recorded sequence', () => {
    const entries = record();
    expect(entries.length).toBe(5);
    const result = replay(entries, createReducer(), initialState());
    expect(result).toEqual({ ok: true });
  });

  it('compares byte payloads structurally, not by reference', () => {
    const initial = readyStateWithInflight([
      { token: 't1', trackId: 'v', seq: 0, url: 'u', sbId: 'sb-v' },
    ]);
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const msg = {
      type: 'SEGMENT_LOADED',
      trackId: 'v',
      seq: 0,
      bytes,
      rtt: 10,
      size: 4,
    } as const;
    const [, effects] = createReducer()(initial, msg);
    expect(effects[0]).toMatchObject({ kind: 'append' });

    const withData = (data: ArrayBuffer): TraceEntry => ({
      t: 0,
      msg,
      effects: effects.map((e) => (e.kind === 'append' ? { ...e, data } : e)),
      digest: 'd',
    });

    // A copy with equal bytes replays clean.
    expect(
      replay([withData(new Uint8Array([1, 2, 3, 4]).buffer)], createReducer(), initial).ok,
    ).toBe(true);
    // Same length, different content diverges.
    expect(
      replay([withData(new Uint8Array([1, 2, 3, 9]).buffer)], createReducer(), initial).ok,
    ).toBe(false);
    // Different length diverges.
    expect(replay([withData(new Uint8Array([1, 2]).buffer)], createReducer(), initial).ok).toBe(
      false,
    );
  });

  it('skips holes in a sparse entry list', () => {
    const entries: TraceEntry[] = [];
    entries[1] = {
      t: 0,
      msg: { type: 'STALLED', at: 1 },
      effects: [{ kind: 'emit', event: 'playback:stalled', payload: { at: 1 } }],
      digest: 'd',
    };
    expect(replay(entries, createReducer(), initialState()).ok).toBe(true);
  });

  it('reports the first divergence when the trace is tampered with', () => {
    const entries = [...record()];
    const tampered = entries[2];
    if (tampered === undefined) throw new Error('expected an entry');
    entries[2] = { ...tampered, effects: [{ kind: 'endOfStream' }] };
    const result = replay(entries, createReducer(), initialState());
    expect(result.ok).toBe(false);
    expect(result.divergedAt).toBe(2);
    expect(result.expected).toEqual([{ kind: 'endOfStream' }]);
    expect(result.actual).toEqual([]);
  });
});
