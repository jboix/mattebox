import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import abr from '../../../src/stages/abr/index.js';
import cmsd, { cmsdParams } from '../../../src/stages/cmsd/index.js';
import type { Rendition } from '../../../src/types/ir.js';
import type { Command } from '../../../src/types/messages.js';
import type { AbrChooser, AbrTelemetry } from '../../../src/types/quality.js';
import type { StageContext, TransportResponseView } from '../../../src/types/stage.js';

function harness() {
  const dispatched: Command[] = [];
  let hook: ((res: TransportResponseView) => void) | null = null;
  cmsd().install({
    dispatch: (cmd: Command) => dispatched.push(cmd),
    addResponseHook: (fn: (res: TransportResponseView) => void) => {
      hook = fn;
      return () => undefined;
    },
  } as unknown as StageContext);
  const respond = (header: string | null, outcome: TransportResponseView['outcome'] = 'success') =>
    (hook as unknown as (res: TransportResponseView) => void)({
      token: 't',
      url: 'https://cdn.example/seg.m4s',
      status: 200,
      rtt: 10,
      size: 1000,
      outcome,
      attempt: 0,
      headers: new Headers(header === null ? {} : { 'CMSD-Dynamic': header }),
    });
  return { dispatched, respond };
}

describe('CMSD-Dynamic', () => {
  it('reads the numeric parameters of the last list member', () => {
    expect([...cmsdParams('"CDN-A";etp=900;rtt=40, "CDN-B";etp=480;mb=6000;rd=12')]).toEqual([
      ['etp', 480],
      ['mb', 6000],
      ['rd', 12],
    ]);
    // Commas and semicolons inside quoted strings are not separators.
    expect(cmsdParams('"a,b;c";etp=5').get('etp')).toBe(5);
    expect(cmsdParams('"edge";n="x";du').size).toBe(0);
  });

  it('turns etp into a throughput hint and mb into the cmsd constraint, only on change', () => {
    const h = harness();
    h.respond('"edge";etp=3000;mb=2000');
    h.respond('"edge";etp=3000;mb=2000');
    h.respond(null);
    h.respond('"edge";etp=9', 'failure');
    h.respond('"edge";etp=1500');
    expect(h.dispatched).toEqual([
      { type: 'THROUGHPUT_HINT', bps: 3_000_000 },
      { type: 'CONSTRAIN', source: 'cmsd', constraint: { maxBitrate: 2_000_000 } },
      { type: 'THROUGHPUT_HINT', bps: 1_500_000 },
      { type: 'RELEASE_CONSTRAINT', source: 'cmsd' },
    ]);
  });
});

describe('the throughput hint', () => {
  const reduce = createReducer();

  it('is kept in the stats and forgotten on null', () => {
    const [hinted] = reduce(initialState(), { type: 'THROUGHPUT_HINT', bps: 2_000_000 });
    expect(hinted.stats.serverThroughput).toBe(2_000_000);
    const [forgotten] = reduce(hinted, { type: 'THROUGHPUT_HINT', bps: null });
    expect(forgotten.stats.serverThroughput).toBeUndefined();
    const [, fx] = reduce(initialState(), { type: 'THROUGHPUT_HINT', bps: -1 });
    expect(fx).toContainEqual(expect.objectContaining({ event: 'command:rejected' }));
  });

  it('caps the abr estimate, and stands alone before any measurement', () => {
    let chooser: AbrChooser | null = null;
    abr().install({
      registerChooser: (c: AbrChooser) => {
        chooser = c;
      },
      reduce() {},
      on: () => () => undefined,
      getState: () => initialState(),
      dispatch() {},
    } as unknown as StageContext);
    const rung = (id: string, bitrate: number): Rendition => ({
      id,
      bitrate,
      codecs: null,
      mimeType: 'video/mp4',
      segments: [],
    });
    const ladder = [rung('low', 500_000), rung('mid', 1_500_000), rung('high', 4_000_000)];
    const pick = (telemetry: Partial<AbrTelemetry>) =>
      (chooser as unknown as AbrChooser).choose(ladder, {
        throughputEwma: 0,
        currentTime: 0,
        current: null,
        ...telemetry,
      } as AbrTelemetry);
    expect(pick({})).toBe('low');
    expect(pick({ serverThroughput: 3_000_000 })).toBe('mid');
    expect(pick({ throughputEwma: 10_000_000, throughputFastEwma: 10_000_000 })).toBe('high');
    expect(
      pick({
        throughputEwma: 10_000_000,
        throughputFastEwma: 10_000_000,
        serverThroughput: 3_000_000,
      }),
    ).toBe('mid');
  });
});
