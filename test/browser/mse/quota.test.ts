import { describe, expect, it } from 'vitest';
import type { Effect } from '../../../src/index.js';
import {
  attachAndOpen,
  createBufferAndWait,
  createStack,
  fixture,
  pickVideoProfile,
  waitFor,
} from './helpers.js';

const profile = pickVideoProfile();

// ~1 MB segments at advancing offsets until the browser throws
// QuotaExceededError. Capped: a browser that never throws within ~500 MB
// skips rather than hangs.
const MAX_APPENDS = 500;
const BURST = 20;

describe.runIf(profile !== null)('quota pressure', () => {
  if (profile === null) return;
  it('eviction relieves QuotaExceededError and playback state survives', async (ctx) => {
    const stack = createStack();
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', profile.type);

    const init = await fixture(profile.init);
    const seg = await fixture(profile.seg);
    stack.runner.run([{ kind: 'append', sbId: 'sb:video', data: init }]);
    await waitFor(() => stack.facts('SOURCEBUFFER_UPDATEEND').length >= 1, 'init appended');

    let appends = 0;
    while (appends < MAX_APPENDS && !stack.hasFact('QUOTA_EXCEEDED')) {
      const burst: Effect[] = [];
      for (let i = 0; i < BURST && appends < MAX_APPENDS; i += 1, appends += 1) {
        burst.push({ kind: 'setTimestampOffset', sbId: 'sb:video', offset: appends * 2 });
        burst.push({ kind: 'append', sbId: 'sb:video', data: seg });
      }
      stack.runner.run(burst);
      const expected = appends + 1;
      await waitFor(
        () =>
          stack.hasFact('QUOTA_EXCEEDED') ||
          stack.facts('SOURCEBUFFER_UPDATEEND').length >= expected,
        'burst drained',
        120_000,
      );
    }

    if (!stack.hasFact('QUOTA_EXCEEDED')) {
      // This browser's quota exceeds the test cap; nothing honest to
      // assert. Skip with the reason on record.
      stack.controller.detach();
      ctx.skip();
      return;
    }

    // Eviction must make progress: the parked append retries after the
    // remove, so updateends keep arriving after the quota fact.
    const atQuota = stack.facts('SOURCEBUFFER_UPDATEEND').length;
    await waitFor(
      () => stack.facts('SOURCEBUFFER_UPDATEEND').length > atQuota,
      'eviction and retry after quota',
      60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const fatal = stack
      .facts('SOURCEBUFFER_ERROR')
      .some((fact) => fact.type === 'SOURCEBUFFER_ERROR' && fact.error.fatal);
    expect(fatal).toBe(false);

    // currentTime is 0 here; the keep-out window around it must survive
    // every eviction pass.
    const buffered = stack.controller.buffered('sb:video');
    expect(buffered.length).toBeGreaterThan(0);
    expect(buffered[0]?.start ?? 1).toBeLessThanOrEqual(0.5);

    stack.controller.detach();
  }, 240_000);
});
