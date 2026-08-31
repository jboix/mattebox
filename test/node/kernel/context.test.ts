import { describe, expect, it } from 'vitest';
import type { SliceReducer } from '../../../src/index.js';
import { createBus } from '../../../src/kernel/bus.js';
import type { HookRegistry } from '../../../src/kernel/context.js';
import { createStageContext } from '../../../src/kernel/context.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';

function deps() {
  const bus = createBus({ reducer: createReducer(), initial: initialState(), now: () => 0 });
  const facade: Record<string, unknown> = {};
  const slices: Array<readonly [string, SliceReducer]> = [];
  const element = {} as HTMLMediaElement;
  const hooks: HookRegistry = {};
  const addRequestHook = () => () => undefined;
  const request = async () => new Response();
  return { bus, facade, slices, element, hooks, addRequestHook, request };
}

describe('stage context', () => {
  it('forwards registrations to the bus registries', () => {
    const d = deps();
    const { ctx } = createStageContext(d);

    const parse = () => [];
    ctx.registerParser('text/vtt', parse);
    expect(d.bus.parserFor('text/vtt')).toBe(parse);

    ctx.registerTransform({ name: 'demux', order: 2, transform: (data) => data });
    ctx.registerTransform({ name: 'decrypt', order: 1, transform: (data) => data });
    expect(d.bus.transforms().map((s) => s.name)).toEqual(['decrypt', 'demux']);

    const sink = {
      contentType: 'text' as const,
      accept: () => [],
      ranges: () => [],
      clear: () => [],
    };
    ctx.registerSink('text', () => sink);
    expect(d.bus.sinkFor('text')).toBeDefined();

    const reducer: SliceReducer = (slice) => [slice ?? null, []];
    ctx.reduce('my-slice', reducer);
    expect(d.slices).toEqual([['my-slice', reducer]]);

    expect(ctx.element).toBe(d.element);
  });

  it('namespaces land on the facade and vanish on teardown', () => {
    const d = deps();
    const { ctx, teardown } = createStageContext(d);
    const api = { latency: 2 };
    ctx.registerNamespace('live', api);
    expect(d.facade.live).toBe(api);
    expect(d.bus.namespaces().get('live')).toBe(api);

    teardown();
    expect('live' in d.facade).toBe(false);
    expect(d.bus.namespaces().has('live')).toBe(false);
  });

  it('sinks, parsers, and transforms registered through the context are undone on teardown', () => {
    const d = deps();
    const { ctx, teardown } = createStageContext(d);
    const step = { name: 't', order: 100, transform: (data: Uint8Array) => data };
    ctx.registerSink('text', (() => ({})) as never);
    ctx.registerParser('application/x-test', (() => ({})) as never);
    ctx.registerTransform(step);
    expect(d.bus.sinkFor('text')).toBeDefined();
    expect(d.bus.parserFor('application/x-test')).toBeDefined();
    expect(d.bus.transforms()).toHaveLength(1);

    teardown();
    expect(d.bus.sinkFor('text')).toBeUndefined();
    expect(d.bus.parserFor('application/x-test')).toBeUndefined();
    expect(d.bus.transforms()).toHaveLength(0);

    // A second install, as after a media-error rebuild, registers cleanly.
    const again = createStageContext(d);
    expect(() => again.ctx.registerSink('text', (() => ({})) as never)).not.toThrow();
    expect(() =>
      again.ctx.registerParser('application/x-test', (() => ({})) as never),
    ).not.toThrow();
    again.teardown();
  });

  it('event subscriptions made through the context die with the stage', () => {
    const d = deps();
    const { ctx, teardown } = createStageContext(d);
    const seen: unknown[] = [];
    ctx.on('ping', (payload) => seen.push(payload));
    d.bus.emitEvent('ping', 1);
    teardown();
    d.bus.emitEvent('ping', 2);
    expect(seen).toEqual([1]);
  });

  it('dispatch goes through the bus queue', () => {
    const d = deps();
    const { ctx } = createStageContext(d);
    ctx.dispatch({ type: 'SET_BUFFER_GOAL', seconds: 42 });
    expect(d.bus.getState().scheduling.bufferGoal).toBe(42);
  });

  it('one chooser per composition; teardown clears it', () => {
    const d = deps();
    const { ctx, teardown } = createStageContext(d);
    const chooser = { choose: () => 'v-1' };
    ctx.registerChooser(chooser);
    expect(d.hooks.abr).toBe(chooser);
    expect(() => ctx.registerChooser({ choose: () => 'v-2' })).toThrow(/already registered/);
    teardown();
    expect(d.hooks.abr).toBeNull();
  });
});
