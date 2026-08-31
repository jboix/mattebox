import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkBoxes } from '../../../src/containers/mp4-box/index.js';
import { demux, unrollTimestamps } from '../../../src/containers/ts-transmux/demux.js';
import { createTransmuxRunner } from '../../../src/containers/ts-transmux/runner.js';
import { transmux } from '../../../src/containers/ts-transmux/transmux.js';

function fixture(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../fixtures/golden/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

function boxPaths(data: Uint8Array): string[] {
  const paths: string[] = [];
  const result = walkBoxes(data, (box) => {
    paths.push(box.path === '' ? box.type : `${box.path}/${box.type}`);
    return true;
  });
  expect(result.error).toBeNull();
  return paths;
}

describe('ts-transmux demux', () => {
  it('separates the muxed elementary streams with timestamps', () => {
    const streams = demux(fixture('muxed.m2ts'));
    expect(streams.notTransportStream).toBe(false);
    expect(streams.video.length).toBeGreaterThan(0);
    expect(streams.audio.length).toBeGreaterThan(0);
    // Every video PES carries a PTS, and the first is a real 90 kHz value.
    expect(streams.video[0]?.pts).toBeTypeOf('number');
    expect(streams.video[0]?.pts).toBeGreaterThan(0);
  });

  it('reports a non-transport-stream input rather than guessing', () => {
    const notTs = new Uint8Array(1000).fill(0x21);
    const streams = demux(notTs);
    expect(streams.notTransportStream).toBe(true);
    expect(streams.video).toHaveLength(0);
  });
});

describe('ts-transmux fMP4 output', () => {
  it('wraps a muxed segment into an init and a media fragment', () => {
    const result = transmux(fixture('muxed.m2ts'), 0);
    expect(result.notTransportStream).toBe(false);
    expect(result.empty).toBe(false);
    expect(result.bytes).not.toBeNull();
    const paths = boxPaths(result.bytes as Uint8Array);
    // The init segment: ftyp then a moov with two traks (video and audio).
    expect(paths).toContain('ftyp');
    expect(paths).toContain('moov');
    expect(paths.filter((p) => p === 'moov/trak')).toHaveLength(2);
    // The media segment: a moof with the timing boxes, then the mdat.
    expect(paths).toContain('moof');
    expect(paths).toContain('moof/traf/tfdt');
    expect(paths).toContain('moof/traf/trun');
    expect(paths).toContain('mdat');
  });

  it('anchors baseMediaDecodeTime to the presentation start, not the raw PTS', () => {
    // Two segments at different playlist offsets must land at those offsets.
    const atZero = transmux(fixture('muxed.m2ts'), 0);
    const atSix = transmux(fixture('muxed.m2ts'), 6);
    expect(atZero.bytes).not.toBeNull();
    expect(atSix.bytes).not.toBeNull();
    // The tfdt payload holds the 64-bit baseMediaDecodeTime; the six-second
    // version must be exactly 6 * 90000 ticks larger for the video track.
    const baseZero = firstTfdt(atZero.bytes as Uint8Array);
    const baseSix = firstTfdt(atSix.bytes as Uint8Array);
    expect(baseZero).toBe(0);
    expect(baseSix).toBe(6 * 90000);
  });

  it('is deterministic: identical input and start yield identical bytes', () => {
    const a = transmux(fixture('muxed.m2ts'), 0);
    const b = transmux(fixture('muxed.m2ts'), 0);
    expect(a.bytes).not.toBeNull();
    expect(Array.from(a.bytes as Uint8Array)).toEqual(Array.from(b.bytes as Uint8Array));
  });

  it('matches the committed golden bytes exactly', () => {
    // The regression tripwire: any change to the box layout or timing shows
    // up here as a byte diff, whether or not playback tests would catch it.
    const produced = transmux(fixture('muxed.m2ts'), 0).bytes as Uint8Array;
    const golden = fixture('muxed.fmp4');
    expect(produced.byteLength).toBe(golden.byteLength);
    expect(Array.from(produced)).toEqual(Array.from(golden));
  });

  it('handles a Main-profile B-frame stream: composition offsets, golden bytes', () => {
    // Access units do not align to PES packets here and PTS differs from DTS.
    // The golden pins the reframed, reordered output; varying composition-time
    // offsets in the trun prove the B-frame reorder is carried, not flattened.
    const produced = transmux(fixture('muxed-bframes.m2ts'), 0).bytes as Uint8Array;
    expect(Array.from(produced)).toEqual(Array.from(fixture('muxed-bframes.fmp4')));
    const cts = videoCts(produced);
    expect(Math.max(...cts)).toBeGreaterThan(0);
    expect(new Set(cts).size).toBeGreaterThan(1);
  });

  it('produces identical bytes through the runner, worker disabled', async () => {
    // The main-thread fallback the runner takes when no Worker is available
    // must match the golden the direct call produced.
    const runner = createTransmuxRunner({ disableWorker: true });
    const result = await runner.run(fixture('muxed.m2ts'), 0);
    expect(runner.path()).toBe('main');
    expect(Array.from(result.bytes as Uint8Array)).toEqual(Array.from(fixture('muxed.fmp4')));
    runner.dispose();
  });

  it('never throws or hangs on a malformed transport stream', () => {
    // A stream that syncs but then degrades into garbage packets.
    const dirty = new Uint8Array(188 * 8);
    for (let i = 0; i < dirty.byteLength; i += 188) dirty[i] = 0x47;
    dirty[1] = 0x40; // a plausible PID/PUSI that references nothing
    expect(() => transmux(dirty, 0)).not.toThrow();
    const result = transmux(dirty, 0);
    // TS framing but no playable elementary stream: empty, not a crash.
    expect(result.notTransportStream).toBe(false);
    expect(result.empty).toBe(true);
    expect(result.bytes).toBeNull();
  });
});

describe('33-bit PTS rollover', () => {
  it('keeps a wrapping timestamp series monotonic', () => {
    const wrap = 0x2_0000_0000;
    // A series that crosses the wrap: near the top, then back near zero.
    const raw = [wrap - 6000, wrap - 3000, 0, 3000, 6000];
    const unrolled = unrollTimestamps(raw);
    for (let i = 1; i < unrolled.length; i += 1) {
      expect(unrolled[i]).toBeGreaterThan(unrolled[i - 1] as number);
    }
    // Each step is the true delta across the wrap.
    expect((unrolled[2] as number) - (unrolled[1] as number)).toBe(3000);
  });

  it('passes nulls through as the previous value', () => {
    expect(unrollTimestamps([1000, null, 2000])).toEqual([1000, 1000, 2000]);
  });
});

/** The signed composition-time offsets across the first (video) trun. */
function videoCts(data: Uint8Array): number[] {
  const cts: number[] = [];
  walkBoxes(data, (box) => {
    if (box.path === 'moof/traf' && box.type === 'trun') {
      const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
      const count = view.getUint32(4);
      // fullbox head (4) + sample_count (4) + data_offset (4), then 16-byte
      // entries whose last field is the signed cts.
      for (let i = 0; i < count; i += 1) cts.push(view.getInt32(12 + i * 16 + 12));
      return false;
    }
    return true;
  });
  return cts;
}

/** Reads the first track's tfdt baseMediaDecodeTime (version 1, 64-bit). */
function firstTfdt(data: Uint8Array): number {
  let base = -1;
  walkBoxes(data, (box) => {
    if (box.path === 'moof/traf' && box.type === 'tfdt' && base === -1) {
      const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
      // FullBox head is 4 bytes; version 1 stores a 64-bit value after it.
      const high = view.getUint32(4);
      const low = view.getUint32(8);
      base = high * 0x1_0000_0000 + low;
    }
    return true;
  });
  return base;
}
