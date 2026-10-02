import { describe, expect, it } from 'vitest';
import { createTransmuxRunner } from '../../../src/containers/ts-transmux/runner.js';

/**
 * The Worker holds no state between segments: the parameter sets a segment
 * cut mid-GOP borrows travel in the request and come back in the response.
 */

async function golden(name: string): Promise<Uint8Array> {
  const res = await fetch(new URL(`../../fixtures/golden/${name}`, import.meta.url));
  return new Uint8Array(await res.arrayBuffer());
}

/** SPS and PPS NAL headers turned into filler data in place, as in a segment cut mid-GOP. */
function withoutParameterSets(ts: Uint8Array): Uint8Array {
  const out = ts.slice();
  for (let i = 0; i + 3 < out.length; i += 1) {
    if (out[i] !== 0 || out[i + 1] !== 0 || out[i + 2] !== 1) continue;
    const type = (out[i + 3] as number) & 0x1f;
    if (type === 7 || type === 8) out[i + 3] = 12;
  }
  return out;
}

describe('the transmux Worker carries parameter sets both ways', () => {
  it('a segment cut mid-GOP transmuxes with the sets of the one before', async () => {
    const runner = createTransmuxRunner();
    const whole = await golden('muxed.m2ts');
    const previous = await runner.run(whole, 0, false, 'video');
    expect(runner.path()).toBe('worker');
    expect(previous.parameterSets?.sps.byteLength).toBeGreaterThan(0);
    const cut = withoutParameterSets(whole);
    const alone = await runner.run(cut, 6, false, 'video');
    expect(alone.bytes).toBeNull();
    const borrowed = await runner.run(cut, 6, false, 'video', previous.parameterSets);
    expect(runner.path()).toBe('worker');
    expect(borrowed.bytes).not.toBeNull();
    runner.dispose();
  });
});
