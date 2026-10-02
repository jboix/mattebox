import { describe, expect, it } from 'vitest';
import { Cea708Service, Dtvcc } from '../../../src/stages/text-cea708/decode.js';

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** DFn (CTA-708-E §8.10.5.12): window `id`, relative anchor, anchor point, rows, columns, style. */
function define(
  id: number,
  o: {
    visible?: boolean;
    v?: number;
    h?: number;
    point?: number;
    rows?: number;
    cols?: number;
    style?: number;
  } = {},
): number[] {
  return [
    0x98 + id,
    (o.visible === true ? 0x20 : 0) | 0x00,
    0x80 | (o.v ?? 90),
    o.h ?? 50,
    ((o.point ?? 7) << 4) | ((o.rows ?? 1) - 1),
    (o.cols ?? 32) - 1,
    ((o.style ?? 1) << 3) | 1,
  ];
}
const DSW = (bits: number) => [0x89, bits];
const HDW = (bits: number) => [0x8a, bits];

/** One service decoding blocks at times; the cues it closed by `end`. */
function run(steps: Array<[number, number[]]>, end: number) {
  const service = new Cea708Service();
  for (const [time, bytes] of steps) service.decode(Uint8Array.from(bytes), time);
  return service.flush(end).map(({ start, end: stop, text }) => [start, stop, text]);
}

describe('the CEA-708 service decoder', () => {
  it('shows a pop-on window on DSW and ends it on HDW, with its layout', () => {
    const service = new Cea708Service();
    service.decode(Uint8Array.from([...define(0), ...ascii('Hello')]), 0);
    service.decode(Uint8Array.from(DSW(0b1)), 1);
    service.decode(Uint8Array.from(HDW(0b1)), 3);
    const [cue] = service.drain();
    expect(cue).toMatchObject({ start: 1, end: 3, text: 'Hello', window: 0 });
    expect(cue?.layout).toEqual({
      priority: 0,
      relative: true,
      anchorVertical: 90,
      anchorHorizontal: 50,
      anchorPoint: 7,
      rows: 1,
      columns: 32,
      justify: 0,
    });
  });

  it('opens a cue per change of a visible window, not per character', () => {
    expect(
      run(
        [
          [0, [...define(0, { visible: true }), ...ascii('Hi')]],
          [1, ascii(' there')],
          [2, [0x0c]], // FF clears the window
        ],
        5,
      ),
    ).toEqual([
      [0, 1, 'Hi'],
      [1, 2, 'Hi there'],
    ]);
  });

  it('scrolls a roll-up window up from its last row on CR', () => {
    expect(
      run(
        [
          [
            0,
            [
              ...define(1, { visible: true, rows: 2 }),
              ...ascii('a'),
              0x0d,
              ...ascii('b'),
              0x0d,
              ...ascii('c'),
            ],
          ],
        ],
        1,
      ),
    ).toEqual([[0, 1, 'b\nc']]);
  });

  it('writes italics and underline as tags and escapes markup', () => {
    // SPA: second byte 0x80 italics, 0x40 underline.
    const text = [
      ...ascii('a<'),
      0x90,
      0x00,
      0xc0,
      ...ascii('b&'),
      0x90,
      0x00,
      0x00,
      ...ascii('c'),
    ];
    expect(run([[0, [...define(0, { visible: true }), ...text]]], 1)).toEqual([
      [0, 1, 'a&lt;<i><u>b&amp;</u></i>c'],
    ]);
  });

  it('maps G0, G1, G2, and G3 characters', () => {
    const text = [0x7f, 0xe9, 0x10, 0x25, 0x10, 0x35, 0x10, 0xa0];
    expect(run([[0, [...define(0, { visible: true }), ...text]]], 1)).toEqual([[0, 1, '♪é…•[CC]']]);
  });

  it('skips C2 and C3 codes by their length', () => {
    // EXT1 0x08 takes one byte after it, EXT1 0x80 four, EXT1 0x90 a counted run.
    const text = [0x10, 0x08, 0x41, 0x10, 0x80, 1, 2, 3, 4, 0x10, 0x90, 0x02, 9, 9, ...ascii('ok')];
    expect(run([[0, [...define(0, { visible: true }), ...text]]], 1)).toEqual([[0, 1, 'ok']]);
  });

  it('places text with SPL and centers style 3 windows, or after SWA', () => {
    const service = new Cea708Service();
    // SPL row 1, column 2 in a two-row window of style 3.
    service.decode(
      Uint8Array.from([
        ...define(0, { visible: true, rows: 2, style: 3 }),
        0x92,
        1,
        2,
        ...ascii('x'),
      ]),
      0,
    );
    // SWA: justify right, in the low bits of its third byte.
    service.decode(Uint8Array.from([0x97, 0, 0, 0x01, 0]), 1);
    const cues = service.flush(2);
    expect(cues.map((c) => [c.text, c.layout.justify])).toEqual([
      ['  x', 2],
      ['  x', 1],
    ]);
  });

  it('holds the commands after DLY until its time, and DLC releases them', () => {
    expect(run([[0, [...define(0), ...ascii('later'), 0x8d, 10, ...DSW(1)]]], 5)).toEqual([
      [1, 5, 'later'],
    ]);
    expect(
      run(
        [
          [0, [...define(0), ...ascii('now'), 0x8d, 50]],
          [0.5, [0x8e, ...DSW(1)]],
        ],
        2,
      ),
    ).toEqual([[0.5, 2, 'now']]);
  });

  it('keeps text across a redefinition and clears it on CLW, deletes on DLW', () => {
    expect(
      run(
        [
          [0, [...define(0, { visible: true }), ...ascii('kept')]],
          [1, define(0, { visible: true, v: 10 })],
          [2, [0x88, 1]],
        ],
        3,
      ).map(([start, end, text]) => [start, end, text]),
    ).toEqual([
      [0, 1, 'kept'],
      [1, 2, 'kept'],
    ]);
    expect(
      run(
        [
          [0, [...define(2, { visible: true }), ...ascii('x')]],
          [1, [0x8c, 0b100, ...ascii('y')]],
        ],
        2,
      ),
    ).toEqual([[0, 1, 'x']]);
  });

  it('starts over on RST', () => {
    expect(
      run(
        [
          [0, [...define(0, { visible: true }), ...ascii('x')]],
          [1, [0x8f, ...ascii('y')]],
        ],
        2,
      ),
    ).toEqual([[0, 1, 'x']]);
  });
});

/** The cc_data triples of one DTVCC packet: a start, then data pairs, padded. */
function packet(sequence: number, data: number[]): Array<[number, number, number]> {
  const bytes = data.length % 2 === 0 ? [...data, 0] : data;
  const sizeCode = (bytes.length + 1) / 2;
  const triples: Array<[number, number, number]> = [[3, (sequence << 6) | sizeCode, bytes[0] ?? 0]];
  for (let i = 1; i < bytes.length; i += 2) triples.push([2, bytes[i] ?? 0, bytes[i + 1] ?? 0]);
  return triples;
}
const block = (service: number, data: number[]) =>
  service < 7
    ? [(service << 5) | data.length, ...data]
    : [(7 << 5) | data.length, service, ...data];

describe('the DTVCC transport', () => {
  it('joins packets from cc_data and routes service blocks, extended numbers too', () => {
    const dtvcc = new Dtvcc();
    const shown = [...define(0, { visible: true }), ...ascii('one')];
    const triples = [
      ...packet(0, [
        ...block(1, shown),
        ...block(12, [...define(0, { visible: true }), ...ascii('twelve')]),
      ]),
      ...packet(1, block(1, [0x0c])),
      ...packet(2, block(12, [0x0c])),
    ];
    triples.forEach(([type, a, b], i) => {
      dtvcc.push(type, a, b, i / 10);
    });
    const cues = dtvcc.drain();
    expect([...cues.keys()]).toEqual([1, 12]);
    expect(cues.get(1)?.map((c) => c.text)).toEqual(['one']);
    expect(cues.get(12)?.map((c) => c.text)).toEqual(['twelve']);
  });

  it('drops a packet cut short by the next start', () => {
    const dtvcc = new Dtvcc();
    const cut = packet(0, block(1, [...define(0, { visible: true }), ...ascii('lost text')])).slice(
      0,
      3,
    );
    const whole = packet(1, block(1, [...define(0, { visible: true }), ...ascii('kept')]));
    const clear = packet(2, block(1, [0x0c]));
    [...cut, ...whole, ...clear].forEach(([type, a, b], i) => {
      dtvcc.push(type, a, b, i);
    });
    expect(
      dtvcc
        .drain()
        .get(1)
        ?.map((c) => c.text),
    ).toEqual(['kept']);
  });

  it('ignores data before any packet start, and stops at a null block', () => {
    const dtvcc = new Dtvcc();
    dtvcc.push(2, 0x41, 0x42, 0);
    for (const [type, a, b] of packet(0, [
      0x00,
      ...block(1, [...define(0, { visible: true }), 0x41]),
    ])) {
      dtvcc.push(type, a, b, 1);
    }
    expect(dtvcc.drain().size).toBe(0);
  });
});
