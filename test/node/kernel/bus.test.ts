import { describe, expect, it } from 'vitest';
import type { Effect, Reducer } from '../../../src/index.js';
import { createBus } from '../../../src/kernel/bus.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';

/** A reducer stub that emits one event effect per STALLED fact and nothing else. */
const echoReducer: Reducer = (state, msg) => {
  if (msg.type === 'STALLED') {
    return [state, [{ kind: 'emit', event: 'echo', payload: { at: msg.at } }]];
  }
  return [state, []];
};

function wiredBus(reducer: Reducer) {
  const bus = createBus({ reducer, initial: initialState(), now: () => 0 });
  const runner = createEffectRunner();
  runner.register('emit', (effect) => {
    bus.emitEvent(effect.event, effect.payload);
    return undefined;
  });
  bus.setEffectSink((effects) => runner.run(effects));
  return bus;
}

describe('reentrancy', () => {
  it('processes commands dispatched from inside a listener in order, without recursion', () => {
    const bus = wiredBus(echoReducer);
    let depth = 0;
    let maxDepth = 0;

    const original = bus.getState();
    bus.on('echo', (payload) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      if ((payload as { at: number }).at === 1) {
        // Two dispatches from inside the flush of the first message.
        bus.dispatch({ type: 'SEEK', to: 2 });
        bus.dispatch({ type: 'SEEK', to: 3 });
      }
      depth -= 1;
    });

    bus.absorb({ type: 'STALLED', at: 1 });

    const order = bus.trace().map((entry) => entry.msg.type);
    expect(order).toEqual(['STALLED', 'SEEK', 'SEEK']);
    expect(maxDepth).toBe(1);
    expect(bus.getState()).toBe(original);
  });

  it('a listener throwing does not break the loop or later listeners', () => {
    const bus = wiredBus(echoReducer);
    const seen: number[] = [];
    bus.on('echo', () => {
      throw new Error('bad listener');
    });
    bus.on('echo', (payload) => {
      seen.push((payload as { at: number }).at);
    });
    bus.absorb({ type: 'STALLED', at: 7 });
    expect(seen).toEqual([7]);
  });

  it('unsubscribe removes a listener', () => {
    const bus = wiredBus(echoReducer);
    const seen: unknown[] = [];
    const off = bus.on('echo', (payload) => seen.push(payload));
    bus.absorb({ type: 'STALLED', at: 1 });
    off();
    bus.absorb({ type: 'STALLED', at: 2 });
    expect(seen).toEqual([{ at: 1 }]);
  });
});

describe('trace ring buffer', () => {
  it('wraps at capacity, keeping the newest entries in order', () => {
    const bus = createBus({
      reducer: createReducer(),
      initial: initialState(),
      now: () => 0,
      traceCapacity: 3,
    });
    for (let at = 1; at <= 5; at += 1) {
      bus.absorb({ type: 'STALLED', at });
    }
    const stalls = bus.trace().map((entry) => (entry.msg.type === 'STALLED' ? entry.msg.at : -1));
    expect(stalls).toEqual([3, 4, 5]);
  });

  it('records message, effects, and a state digest per entry', () => {
    const bus = createBus({ reducer: createReducer(), initial: initialState(), now: () => 42 });
    bus.dispatch({ type: 'SET_BUFFER_GOAL', seconds: 60 });
    const [entry] = bus.trace();
    expect(entry).toMatchObject({ t: 42, msg: { type: 'SET_BUFFER_GOAL', seconds: 60 } });
    expect(entry?.digest).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('registries', () => {
  it('stores capabilities, sinks, parsers, transforms, and namespaces', () => {
    const bus = wiredBus(createReducer());
    bus.registerCapability('live');
    bus.registerCapability({ contentType: 'text', mimeType: 'text/vtt' });
    expect(bus.capabilities()).toEqual(['live', { contentType: 'text', mimeType: 'text/vtt' }]);

    const factory = () => ({
      contentType: 'video' as const,
      accept: (): Effect[] => [],
      ranges: () => [],
      clear: (): Effect[] => [],
    });
    bus.registerSink('video', factory);
    expect(bus.sinkFor('video')).toBe(factory);
    expect(bus.sinkFor('audio')).toBeUndefined();
    expect(() => bus.registerSink('video', factory)).toThrowError(/duplicate sink/);

    const parse = () => [];
    bus.registerParser('text/vtt', parse);
    expect(bus.parserFor('text/vtt')).toBe(parse);
    expect(() => bus.registerParser('text/vtt', parse)).toThrowError(/duplicate parser/);

    bus.registerTransform({ name: 'demux', order: 2, transform: (data) => data });
    bus.registerTransform({ name: 'decrypt', order: 1, transform: (data) => data });
    expect(bus.transforms().map((step) => step.name)).toEqual(['decrypt', 'demux']);

    const api = { latency: 0 };
    bus.registerNamespace('live', api);
    expect(bus.namespaces().get('live')).toBe(api);
    expect(() => bus.registerNamespace('live', api)).toThrowError(/duplicate namespace/);
  });

  it('route feeds commands and facts through the same ordered queue', () => {
    const bus = wiredBus(createReducer());
    bus.route({ type: 'SET_BUFFER_GOAL', seconds: 15 });
    bus.route({ type: 'STALLED', at: 1 });
    expect(bus.trace().map((entry) => entry.msg.type)).toEqual(['SET_BUFFER_GOAL', 'STALLED']);
    expect(bus.getState().scheduling.bufferGoal).toBe(15);
  });
});
