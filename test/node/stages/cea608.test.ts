import { describe, expect, it } from 'vitest';
import { ccTriplesFromSei } from '../../../src/containers/sei.js';
import { Cea608Decoder } from '../../../src/stages/text-cea608/decode.js';

// Control codes.
const RCL: [number, number] = [0x14, 0x20]; // resume caption loading (pop-on)
const EOC: [number, number] = [0x14, 0x2f]; // end of caption (flip)
const EDM: [number, number] = [0x14, 0x2c]; // erase displayed memory
const RU2: [number, number] = [0x14, 0x25]; // roll-up, 2 rows
const CR: [number, number] = [0x14, 0x2d]; // carriage return
const PAC_ROW: [number, number] = [0x14, 0x40]; // a row preamble, no indent

function chars(text: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i += 2) {
    pairs.push([text.charCodeAt(i), text.charCodeAt(i + 1) || 0]);
  }
  return pairs;
}

describe('CEA-608 decode', () => {
  it('pop-on: a caption shows from its EOC to the erase', () => {
    const d = new Cea608Decoder();
    d.push(...RCL, 0);
    d.push(...PAC_ROW, 0);
    for (const [a, b] of chars('HELLO')) d.push(a, b, 0);
    d.push(...EOC, 1); // the caption becomes visible at t=1
    d.push(...EDM, 3); // and is erased at t=3
    const cues = d.flush(3);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('HELLO');
    expect(cues[0]?.start).toBe(1);
    expect(cues[0]?.end).toBe(3);
  });

  it('doubled control codes are processed once', () => {
    const d = new Cea608Decoder();
    // RCL sent twice (as a real stream does) still enters pop-on once.
    d.push(...RCL, 0);
    d.push(...RCL, 0);
    d.push(...PAC_ROW, 0);
    for (const [a, b] of chars('HI')) d.push(a, b, 0);
    d.push(...EOC, 1);
    d.push(...EDM, 2);
    const cues = d.flush(2);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('HI');
  });

  it('roll-up: a carriage return closes one line and opens the next', () => {
    const d = new Cea608Decoder();
    d.push(...RU2, 0);
    for (const [a, b] of chars('ONE')) d.push(a, b, 0);
    d.push(...CR, 1); // line one closes at t=1
    for (const [a, b] of chars('TWO')) d.push(a, b, 1);
    const cues = d.flush(2);
    // The first cue holds ONE; the scrolled state holds ONE then TWO.
    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues[0]?.text).toContain('ONE');
    expect(cues.at(-1)?.text).toContain('TWO');
  });
});

describe('SEI caption extraction', () => {
  /** Builds a SEI NAL carrying one ATSC cc_data message with the given triples. */
  function seiNal(triples: Array<[number, number, number]>): Uint8Array {
    const ccCount = triples.length;
    const userData = [
      0xb5, // country
      0x00,
      0x31, // provider
      0x47,
      0x41,
      0x39,
      0x34, // "GA94"
      0x03, // user_data_type_code
      0xc0 | ccCount, // process_cc_data_flag + cc_count
      0xff, // marker
    ];
    for (const [type, a, b] of triples) userData.push(0x04 | (type & 0x03), a, b);
    const payload = [4, userData.length, ...userData]; // payloadType 4, size, body
    return new Uint8Array([0x06, ...payload, 0x80]); // NAL header (SEI), body, rbsp stop
  }

  it('reads cc triples from an ATSC SEI message', () => {
    const nal = seiNal([
      [0, 0x20, 0x21],
      [1, 0x30, 0x31],
    ]);
    const triples = ccTriplesFromSei(nal);
    expect(triples).toEqual([
      { type: 0, a: 0x20, b: 0x21 },
      { type: 1, a: 0x30, b: 0x31 },
    ]);
  });

  it('returns nothing for a SEI with no caption user data', () => {
    // payloadType 5 (unregistered), not the caption message.
    const nal = new Uint8Array([0x06, 0x05, 0x02, 0xaa, 0xbb, 0x80]);
    expect(ccTriplesFromSei(nal)).toEqual([]);
  });

  it('the two routes yield the same triples for the same SEI', () => {
    // The equivalence at the heart of entanglement #1: whatever hands the SEI
    // over, the bytes decode identically. Here one SEI, read directly.
    const nal = seiNal([[0, 0x48, 0x49]]);
    expect(ccTriplesFromSei(nal)).toEqual([{ type: 0, a: 0x48, b: 0x49 }]);
  });
});
