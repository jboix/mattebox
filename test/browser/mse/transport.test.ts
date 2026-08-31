import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/kernel/bus.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';
import { createMseController } from '../../../src/kernel/mse.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { createTransport } from '../../../src/kernel/transport.js';
import { pickVideoProfile, waitFor } from './helpers.js';

const profile = pickVideoProfile();

function fixtureUrl(name: string): string {
  return new URL(`../../fixtures/segments/${name}`, import.meta.url).href;
}

describe.runIf(profile !== null)('transport against a real server and real buffers', () => {
  if (profile === null) return;

  it('fetches a fixture over the network and appends it to a real SourceBuffer', async () => {
    // Full loop: fetch effect -> transport -> SEGMENT_LOADED fact ->
    // reducer -> append effect -> append queue -> real buffered ranges.
    const initial = {
      ...initialState(),
      lifecycle: { phase: 'ready' as const },
      scheduling: {
        inflight: new Map([
          [
            't1:v:0',
            {
              token: 't1:v:0',
              trackId: 'v',
              seq: 0,
              url: fixtureUrl(profile.seg),
              sbId: 'sb:video',
              timestampOffset: 0,
            },
          ],
        ]),
        bufferGoal: 30,
        tokenSeq: 1,
      },
    };
    const bus = createBus({ reducer: createReducer(), initial });
    const runner = createEffectRunner();
    const controller = createMseController({ absorb: (fact) => bus.absorb(fact) });
    controller.registerHandlers(runner);
    const transport = createTransport({
      absorb: (fact) => bus.absorb(fact),
      inflight: (token) => bus.getState().scheduling.inflight.get(token),
    });
    transport.registerHandlers(runner);
    runner.register('emit', () => undefined);
    bus.setEffectSink((effects) => runner.run(effects));

    const el = document.createElement('video');
    el.muted = true;
    controller.attach(el);
    await waitFor(() => controller.readyState() === 'open', 'sourceopen');
    runner.run([{ kind: 'createSourceBuffer', sbId: 'sb:video', codecs: profile.type }]);
    await waitFor(() => bus.getState().buffers.has('sb:video'), 'buffer created');

    // The init segment goes straight to the queue; the media segment
    // travels the full transport path.
    const init = await (await fetch(fixtureUrl(profile.init))).arrayBuffer();
    runner.run([{ kind: 'append', sbId: 'sb:video', data: init }]);
    runner.run([{ kind: 'fetch', token: 't1:v:0', url: fixtureUrl(profile.seg) }]);

    await waitFor(
      () => (bus.getState().buffers.get('sb:video')?.ranges.length ?? 0) > 0,
      'real ranges reported back into state',
      20_000,
    );
    const ranges = bus.getState().buffers.get('sb:video')?.ranges ?? [];
    expect(ranges[0]?.end ?? 0).toBeGreaterThan(1);
    // The transport measured the transfer.
    expect(bus.getState().stats.throughputEwma).toBeGreaterThan(0);
    expect(bus.getState().scheduling.inflight.size).toBe(0);
    controller.detach();
  }, 30_000);

  it('abort during a real in-flight request leaves no pending state', async () => {
    const facts: string[] = [];
    const runner = createEffectRunner();
    const transport = createTransport({
      absorb: (fact) => {
        facts.push(fact.type);
      },
      inflight: () => undefined,
    });
    transport.registerHandlers(runner);

    runner.run([{ kind: 'fetch', token: 't1', url: fixtureUrl(profile.seg) }]);
    expect(transport.pending()).toEqual(['t1']);
    runner.run([{ kind: 'abort', token: 't1' }]);

    // Give the rejection a beat to propagate on the real network stack.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(transport.pending()).toEqual([]);
    expect(facts).toEqual([]);
  });
});
