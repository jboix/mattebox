import { describe, expectTypeOf, it } from 'vitest';
import type { Mattebox, Rendition, TracedError } from '../../src/index.js';

declare const engine: Mattebox;

describe('facade', () => {
  it('kernel surfaces are always present and typed', () => {
    expectTypeOf(engine.quality.active).toEqualTypeOf<Rendition | null>();
    expectTypeOf(engine.quality.playing).toEqualTypeOf<Rendition | null>();
    expectTypeOf(engine.error).toEqualTypeOf<TracedError | null>();
    expectTypeOf(engine.media).toEqualTypeOf<HTMLMediaElement | null>();
    expectTypeOf(engine.accepts).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(engine.accepts).returns.toEqualTypeOf<boolean>();
  });

  it('the live namespace types through declaration merging, as optional presence', () => {
    // The live adapters merge LiveApi into MatteboxNamespaces; presence
    // stays optional because it depends on the composed stages.
    expectTypeOf(engine.live?.edge).toEqualTypeOf<number | null | undefined>();
  });
});
