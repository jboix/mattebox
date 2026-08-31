import { describe, expectTypeOf, it } from 'vitest';
import type { Bus, Command, Effect, Fact, Message } from '../../src/index.js';

declare const bus: Bus;

describe('command and fact separation', () => {
  it('a command cannot be passed to absorb', () => {
    // @ts-expect-error a command is rejectable intent, not a fact
    bus.absorb({ type: 'SEEK', to: 10 });
  });

  it('a fact cannot be passed to dispatch', () => {
    // @ts-expect-error a fact reports what already happened and cannot be dispatched
    bus.dispatch({ type: 'SEEKED', at: 10 });
  });

  it('the unions are disjoint and exhaustive over Message', () => {
    expectTypeOf<Extract<Command, Fact>>().toEqualTypeOf<never>();
    expectTypeOf<Message>().toEqualTypeOf<Command | Fact>();
  });
});

describe('effects are plain serializable data', () => {
  it('an effect containing a function is a type error', () => {
    // @ts-expect-error an emit payload must be serializable data, not a function
    const bad: Effect = { kind: 'emit', event: 'x', payload: () => undefined };
    void bad;
  });

  it('a nested function inside a payload is a type error', () => {
    // @ts-expect-error serializability is enforced recursively
    const bad: Effect = { kind: 'emit', event: 'x', payload: { onDone: () => undefined } };
    void bad;
  });

  it('every async effect carries a token', () => {
    expectTypeOf<Extract<Effect, { kind: 'fetch' }>>().toHaveProperty('token');
    expectTypeOf<Extract<Effect, { kind: 'abort' }>>().toHaveProperty('token');
    expectTypeOf<Extract<Effect, { kind: 'schedule' }>>().toHaveProperty('token');
  });
});
