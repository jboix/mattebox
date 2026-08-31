import { describe, expectTypeOf, it } from 'vitest';
import type { Mattebox } from '../../src/index.js';

interface ThumbnailsApi {
  at(time: number): string | null;
}

// What a stage's typings do: merge its namespace into the package entry.
declare module '../../src/index.js' {
  interface MatteboxNamespaces {
    thumbnails: ThumbnailsApi;
  }
}

declare const engine: Mattebox;

describe('namespace declaration merging', () => {
  it('a merged namespace is typed on the facade, optional because presence depends on loading', () => {
    expectTypeOf(engine.thumbnails).toEqualTypeOf<ThumbnailsApi | undefined>();
  });
});
