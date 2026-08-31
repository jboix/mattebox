import { describe, expect, it } from 'vitest';
import type { Effect, Serializable } from '../../../src/index.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';

describe('effect runner', () => {
  it('dispatches each effect to the handler registered for its kind', () => {
    const runner = createEffectRunner();
    const seen: Effect[] = [];
    runner.register('setDuration', (effect) => {
      seen.push(effect);
      return undefined;
    });
    runner.register('endOfStream', (effect) => {
      seen.push(effect);
      return undefined;
    });
    runner.run([{ kind: 'setDuration', seconds: 600 }, { kind: 'endOfStream' }]);
    expect(seen).toEqual([{ kind: 'setDuration', seconds: 600 }, { kind: 'endOfStream' }]);
  });

  it('reports an unhandled effect kind as an event, not a throw', () => {
    const events: Array<[string, Serializable]> = [];
    const runner = createEffectRunner({
      onEvent: (event, payload) => events.push([event, payload]),
    });
    runner.run([{ kind: 'seekElement', to: 3 }]);
    expect(events).toEqual([['kernel:effect-unhandled', { kind: 'seekElement' }]]);
  });

  it('contains a throwing handler and reports it', () => {
    const events: Array<[string, Serializable]> = [];
    const runner = createEffectRunner({
      onEvent: (event, payload) => events.push([event, payload]),
    });
    runner.register('setDuration', () => {
      throw new Error('handler failed');
    });
    runner.run([{ kind: 'setDuration', seconds: 1 }]);
    expect(events).toEqual([
      ['kernel:effect-error', { kind: 'setDuration', message: 'Error: handler failed' }],
    ]);
  });

  it('stores a returned cancel under the token and aborts it exactly once', () => {
    const runner = createEffectRunner();
    const cancelled: string[] = [];
    runner.register('fetch', (effect) => () => {
      cancelled.push(effect.token);
    });
    runner.run([{ kind: 'fetch', token: 't1', url: 'u' }]);
    expect(runner.pending()).toEqual(['t1']);

    runner.run([{ kind: 'abort', token: 't1' }]);
    expect(cancelled).toEqual(['t1']);
    expect(runner.pending()).toEqual([]);

    // A second abort for the same token is a no-op.
    runner.run([{ kind: 'abort', token: 't1' }]);
    expect(cancelled).toEqual(['t1']);
  });

  it('forwards abort effects to an optional abort handler after cancelling', () => {
    const runner = createEffectRunner();
    const observed: string[] = [];
    runner.register('abort', (effect) => {
      observed.push(effect.token);
      return undefined;
    });
    runner.run([{ kind: 'abort', token: 'ghost' }]);
    expect(observed).toEqual(['ghost']);
  });

  it('cancel() works directly and contains a throwing cancel function', () => {
    const events: Array<[string, Serializable]> = [];
    const runner = createEffectRunner({
      onEvent: (event, payload) => events.push([event, payload]),
    });
    runner.register('fetch', () => () => {
      throw new Error('cancel failed');
    });
    runner.run([{ kind: 'fetch', token: 't1', url: 'u' }]);
    runner.cancel('t1');
    expect(events).toEqual([
      ['kernel:effect-error', { kind: 'abort', message: 'Error: cancel failed' }],
    ]);
    expect(runner.pending()).toEqual([]);
  });

  it('rejects duplicate handler registration', () => {
    const runner = createEffectRunner();
    runner.register('emit', () => undefined);
    expect(() => runner.register('emit', () => undefined)).toThrowError(/duplicate handler/);
  });

  it('a schedule handler can feed the queued message back', () => {
    const runner = createEffectRunner();
    const fed: string[] = [];
    runner.register('schedule', (effect) => {
      fed.push(effect.then.type);
      return undefined;
    });
    runner.run([
      // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
      { kind: 'schedule', token: 't1', delayMs: 100, then: { type: 'STALLED', at: 1 } },
    ]);
    expect(fed).toEqual(['STALLED']);
  });

  it('forget drops a cancel without invoking it; cancelAll invokes every remaining one', () => {
    const runner = createEffectRunner();
    const cancelled: string[] = [];
    runner.register('schedule', (effect) => () => cancelled.push(effect.token));
    const schedule = (token: string) =>
      // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
      ({ kind: 'schedule', token, delayMs: 0, then: { type: 'DETACH' } }) as const;
    runner.run([schedule('a'), schedule('b'), schedule('c')]);
    runner.forget('a');
    expect(runner.pending()).toEqual(['b', 'c']);
    runner.cancelAll();
    expect(cancelled).toEqual(['b', 'c']);
    expect(runner.pending()).toEqual([]);
    // Idempotent: nothing left to cancel.
    runner.cancelAll();
    expect(cancelled).toEqual(['b', 'c']);
  });
});
