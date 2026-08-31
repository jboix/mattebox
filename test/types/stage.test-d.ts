import { describe, it } from 'vitest';
import type { Sink, Stage, StageContext } from '../../src/index.js';

declare function defineStage(stage: Stage): void;
declare const ctx: StageContext;
declare const textSink: Sink<'text'>;

describe('stage contract', () => {
  it('a stage missing install is a type error', () => {
    // @ts-expect-error install is required
    defineStage({ name: 'incomplete' });
  });

  it('a well-formed stage is accepted', () => {
    defineStage({
      name: 'noop',
      requires: ['rendition-select'],
      provides: ['noop'],
      install: () => undefined,
    });
  });

  it('a sink cannot be registered under a different content type', () => {
    // @ts-expect-error a text sink is not a video sink
    ctx.registerSink('video', () => textSink);
  });

  it('a sink registers under its own content type', () => {
    ctx.registerSink('text', () => textSink);
  });
});
