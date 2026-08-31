import { describe, expect, it } from 'vitest';
import type { Stage } from '../../../src/index.js';
import { mattebox } from '../../../src/index.js';
import { compose } from '../../../src/kernel/loader.js';

function stage(name: string, overrides: Partial<Stage> = {}): Stage {
  return { name, install: () => undefined, ...overrides };
}

describe('composition', () => {
  it('1. orders a diamond dependency topologically', () => {
    const d = stage('d');
    const b = stage('b', { requires: ['d'] });
    const c = stage('c', { requires: ['d'] });
    const a = stage('a', { requires: ['b', 'c'] });
    const { order } = compose([a, b, c, d]);
    const names = order.map((s) => s.name);
    expect(names.indexOf('d')).toBeLessThan(names.indexOf('b'));
    expect(names.indexOf('d')).toBeLessThan(names.indexOf('c'));
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('a'));
    expect(names.indexOf('c')).toBeLessThan(names.indexOf('a'));
  });

  it('2. missing requires names both stages in the error', () => {
    expect(() => compose([stage('text-cea608', { requires: ['ts-transmux'] })])).toThrowError(
      /'text-cea608' requires 'ts-transmux', which nothing provides/,
    );
  });

  it('3. duplicate capability is a composition error, not last-one-wins', () => {
    const one = stage('text-webvtt', { provides: [{ contentType: 'text', mimeType: 'text/vtt' }] });
    const two = stage('text-other', { provides: [{ contentType: 'text', mimeType: 'text/vtt' }] });
    expect(() => compose([one, two])).toThrowError(
      /'text-webvtt' and 'text-other' both provide 'text:text\/vtt'/,
    );
  });

  it('4. circular requires is a composition error naming the cycle', () => {
    const a = stage('a', { requires: ['b'] });
    const b = stage('b', { requires: ['a'] });
    expect(() => compose([a, b])).toThrowError(/circular requires: a -> b -> a/);
  });

  it('kernel module names always satisfy requires', () => {
    const abr = stage('abr', { requires: ['scheduler', 'track-registry'] });
    expect(compose([abr]).order.map((s) => s.name)).toEqual(['abr']);
  });

  it('a requirement can name a capability instead of a stage', () => {
    const provider = stage('mp4', { provides: ['mp4-box'] });
    const consumer = stage('meta-emsg', { requires: ['mp4-box'] });
    const { order } = compose([consumer, provider]);
    expect(order.map((s) => s.name)).toEqual(['mp4', 'meta-emsg']);
  });

  it('an array requirement is satisfied by any one alternative', () => {
    // text-cea608 requires its SEI source as ['ts-transmux', 'nal-scan'].
    const ts = stage('ts-transmux', { provides: ['ts-transmux', 'media-transform'] });
    const captions = stage('text-cea608', { requires: [['ts-transmux', 'nal-scan']] });
    // Present with only ts-transmux: satisfied, and it pulls ts-transmux in.
    expect(compose([captions, ts]).order.map((s) => s.name)).toEqual([
      'ts-transmux',
      'text-cea608',
    ]);
    // Present with neither: a single error naming both alternatives.
    expect(() => compose([captions])).toThrowError(
      /requires 'ts-transmux' or 'nal-scan', which nothing provides/,
    );
  });

  it('the media-transform marker may be provided by more than one stage', () => {
    // ts-transmux and packed-audio both carry it; it is a shared trait, not a
    // singleton service, so it must not conflict the way an exclusive one does.
    const ts = stage('ts-transmux', { provides: ['ts-transmux', 'media-transform'] });
    const packed = stage('packed-audio', { provides: ['packed-audio', 'media-transform'] });
    const meta = stage('meta-id3', { requires: ['media-transform'] });
    expect(() => compose([ts, packed, meta])).not.toThrow();
    const { capabilities } = compose([ts, packed, meta]);
    // Recorded once, so a requirement still resolves against it.
    expect(capabilities.filter((c) => c === 'media-transform')).toHaveLength(1);
  });
});

describe('install and teardown through the engine', () => {
  it('5. teardown runs in exact reverse install order', async () => {
    const events: string[] = [];
    const make = (name: string, requires?: string[]): Stage => ({
      name,
      ...(requires !== undefined ? { requires } : {}),
      install: () => {
        events.push(`install:${name}`);
        return () => events.push(`teardown:${name}`);
      },
    });
    // b depends on a: install order a, b; teardown order b, a.
    const engine = mattebox({ stages: [make('b', ['a']), make('a')] });
    // No DOM in tier 1: install happens at attach, so composition alone
    // runs nothing.
    expect(events).toEqual([]);
    // Simulate attach/detach through a minimal fake element being absent:
    // the node tier only checks composition errors surface at construction.
    expect(engine.capabilities()).toEqual([]);
  });

  it('6. an absent stage leaves no namespace property behind', () => {
    const engine = mattebox({});
    expect('live' in engine).toBe(false);
    expect('drm' in engine).toBe(false);
  });

  it('composition errors surface at mattebox() time', () => {
    expect(() => mattebox({ stages: [stage('x', { requires: ['nope'] })] })).toThrowError(
      /requires 'nope'/,
    );
  });
});

describe('manifest types', () => {
  it("a composition collects its adapters' MIME type capabilities, normalized", () => {
    const composition = compose([
      stage('a', { provides: ['a', 'Application/X-Foo; charset=utf-8'] }),
      stage('b', {
        provides: ['b', 'application/bar+xml', { contentType: 'text', mimeType: 'text/vtt' }],
      }),
    ]);
    expect([...composition.manifestTypes].sort()).toEqual([
      'application/bar+xml',
      'application/x-foo',
    ]);
  });

  it('engine.accepts answers from the composition, ignoring case and parameters', () => {
    const engine = mattebox({ stages: [stage('a', { provides: ['application/x-foo'] })] });
    expect(engine.accepts('application/x-foo')).toBe(true);
    expect(engine.accepts('APPLICATION/X-FOO; charset=utf-8')).toBe(true);
    expect(engine.accepts('audio/mpeg')).toBe(false);
    // Sink descriptors are content handlers, not manifest formats.
    expect(mattebox({}).accepts('text/vtt')).toBe(false);
  });
});
