import { describe, expect, it } from 'vitest';
import { scte35Summary } from '../../../src/containers/scte35.js';

const bytes = (base64: string) => Uint8Array.from([...atob(base64)].map((c) => c.charCodeAt(0)));

// The sample sections of SCTE 35 §14.
const TIME_SIGNAL_PLACEMENT_START =
  '/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg==';
const SPLICE_INSERT_OUT = '/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=';

describe('the SCTE-35 summary', () => {
  it('reads a time_signal with a placement opportunity start', () => {
    expect(scte35Summary(bytes(TIME_SIGNAL_PLACEMENT_START))).toEqual({
      commandType: 6,
      segmentations: [{ eventId: 0x4800008e, cancel: false, typeId: 0x34, duration: 307 }],
    });
  });

  it('reads a splice_insert out of network with its break duration', () => {
    const summary = scte35Summary(bytes(SPLICE_INSERT_OUT));
    expect(summary).toMatchObject({
      commandType: 5,
      eventId: 0x4800008f,
      cancel: false,
      outOfNetwork: true,
      segmentations: [],
    });
    expect(summary?.breakDuration).toBeCloseTo(5_426_421 / 90_000, 9);
  });

  it('reads a cancelled splice_insert', () => {
    const section = bytes(SPLICE_INSERT_OUT);
    section[18] = 0xff; // splice_event_cancel_indicator
    expect(scte35Summary(section)).toMatchObject({ commandType: 5, cancel: true });
  });

  it('answers null for bytes that are not a section, and never throws on a cut one', () => {
    expect(scte35Summary(new Uint8Array(20))).toBeNull();
    const whole = bytes(TIME_SIGNAL_PLACEMENT_START);
    for (let length = 0; length < whole.length; length += 1) {
      expect(() => scte35Summary(whole.subarray(0, length))).not.toThrow();
    }
  });
});
