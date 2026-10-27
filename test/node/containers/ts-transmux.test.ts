import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkBoxes } from '../../../src/containers/mp4-box/index.js';
import { demux, unrollTimestamps } from '../../../src/containers/ts-transmux/demux.js';
import { createTransmuxRunner } from '../../../src/containers/ts-transmux/runner.js';
import { transmuxSource } from '../../../src/containers/ts-transmux/source.js';
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

  it('keeps only the requested elementary stream and reports the dropped audio', () => {
    const videoOnly = transmux(fixture('muxed.m2ts'), 0, false, 'video');
    expect(videoOnly.bytes).not.toBeNull();
    expect(videoOnly.droppedAudio).toBe(true);
    const videoPaths = boxPaths(videoOnly.bytes as Uint8Array);
    expect(videoPaths.filter((p) => p === 'moov/trak')).toHaveLength(1);
    expect(videoPaths.filter((p) => p === 'moof/traf')).toHaveLength(1);

    const audioOnly = transmux(fixture('muxed.m2ts'), 0, false, 'audio');
    expect(audioOnly.bytes).not.toBeNull();
    expect(audioOnly.droppedAudio).toBe(false);
    expect(boxPaths(audioOnly.bytes as Uint8Array).filter((p) => p === 'moov/trak')).toHaveLength(
      1,
    );

    // The default keeps both and reports nothing dropped.
    expect(transmux(fixture('muxed.m2ts'), 0).droppedAudio).toBe(false);
  });

  it('puts the earlier track at the presentation start, and keeps the other at its distance', () => {
    // The fixture's audio starts 23.2 ms before its video (PTS 1.4000 and 1.4232).
    const atZero = transmux(fixture('muxed.m2ts'), 0);
    const atSix = transmux(fixture('muxed.m2ts'), 6);
    expect(atZero.bytes).not.toBeNull();
    expect(atSix.bytes).not.toBeNull();
    const [videoZero, audioZero] = tfdts(atZero.bytes as Uint8Array);
    const [videoSix, audioSix] = tfdts(atSix.bytes as Uint8Array);
    expect(audioZero).toBe(0);
    expect(videoZero).toBe(2090);
    // The six-second version is exactly six seconds later on both tracks.
    expect(videoSix).toBe(6 * 90000 + 2090);
    expect(audioSix).toBe(6 * 44100);
  });

  it('places a segment by the anchor of its timeline, as a separate rendition of it', () => {
    // A video rendition sets the anchor; the audio rendition of the same
    // timeline lands at its own distance from it, not at its playlist start.
    const video = transmux(fixture('muxed.m2ts'), 10, false, 'video');
    expect(video.anchor).toEqual({ pts: expect.any(Number), time: 10 });
    const [videoBase] = tfdts(video.bytes as Uint8Array);
    expect(videoBase).toBe(10 * 90000);
    const timing = { anchor: video.anchor, tolerance: 6 };
    const audio = transmux(fixture('muxed.m2ts'), 10, false, 'audio', null, timing);
    expect(audio.anchor).toBe(video.anchor);
    const [audioBase] = tfdts(audio.bytes as Uint8Array);
    expect(audioBase).toBe(Math.round((10 - 2090 / 90000) * 44100));
  });

  it('sets a new anchor for a segment whose clock jumped past the tolerance', () => {
    const video = transmux(fixture('muxed.m2ts'), 10, false, 'video');
    // The same bytes listed 20 seconds later: no encoder offset is that large.
    const jumped = transmux(fixture('muxed.m2ts'), 30, false, 'audio', null, {
      anchor: video.anchor,
      tolerance: 6,
    });
    expect(jumped.anchor).toEqual({ pts: expect.any(Number), time: 30 });
    expect(tfdts(jumped.bytes as Uint8Array)[0]).toBe(30 * 44100);
  });

  it('drops the audio frames an anchor puts before the presentation start', () => {
    const video = transmux(fixture('muxed.m2ts'), 0, false, 'video');
    const whole = transmux(fixture('muxed.m2ts'), 0, false, 'audio');
    const trimmed = transmux(fixture('muxed.m2ts'), 0, false, 'audio', null, {
      anchor: video.anchor,
      tolerance: 6,
    });
    // 23.22 ms before zero: one frame of 1024 samples at 44.1 kHz is 23.22 ms,
    // just short of it, so two frames go.
    const [base] = tfdts(trimmed.bytes as Uint8Array);
    expect(base).toBe(Math.round(((2 * 1024) / 44100) * 44100 - (2090 / 90000) * 44100));
    expect(sampleCount(trimmed.bytes as Uint8Array)).toBe(
      sampleCount(whole.bytes as Uint8Array) - 2,
    );
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
    const runner = createTransmuxRunner({ disableWorker: true }, transmuxSource);
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

/** The bytes before the first moof: the init segment. */
function initLength(bytes: Uint8Array): number {
  for (let i = 4; i + 4 <= bytes.length; i += 1) {
    if (
      bytes[i] === 0x6d &&
      bytes[i + 1] === 0x6f &&
      bytes[i + 2] === 0x6f &&
      bytes[i + 3] === 0x66
    ) {
      return i - 4;
    }
  }
  return bytes.length;
}

/**
 * The fixture as a segment cut mid-GOP: its SPS and PPS NAL headers become
 * filler data (type 12) in place, so the TS and PES framing stay intact.
 */
function withoutParameterSets(ts: Uint8Array): Uint8Array {
  const out = ts.slice();
  let patched = 0;
  for (let i = 0; i + 3 < out.length; i += 1) {
    if (out[i] !== 0 || out[i + 1] !== 0 || out[i + 2] !== 1) continue;
    const type = (out[i + 3] as number) & 0x1f;
    if (type === 7 || type === 8) {
      out[i + 3] = 12;
      patched += 1;
    }
  }
  expect(patched).toBe(2);
  return out;
}

describe('the ID3 metadata stream', () => {
  // muxed-id3.m2ts is muxed.m2ts plus one ID3 PES, one second after the
  // first video PTS (test/e2e/inject-id3.mjs).
  it('returns each tag at its presentation time and leaves the media as it was', () => {
    const result = transmux(fixture('muxed-id3.m2ts'), 10);
    expect(result.metadata).toHaveLength(1);
    // One second after the video, which starts 23.2 ms after the audio.
    expect(result.metadata[0]?.time).toBeCloseTo(11 + 2090 / 90000, 6);
    expect([...(result.metadata[0]?.bytes.subarray(0, 3) ?? [])]).toEqual([0x49, 0x44, 0x33]);
    expect(result.bytes).toEqual(transmux(fixture('muxed.m2ts'), 10).bytes);
    expect(transmux(fixture('muxed.m2ts'), 10).metadata).toEqual([]);
  });

  it('copies each tag out of the segment, so a Worker posts only the tag', () => {
    const [tag] = transmux(fixture('muxed-id3.m2ts'), 0).metadata;
    expect(tag?.bytes.byteLength).toBe(tag?.bytes.buffer.byteLength);
  });

  it('comes back the same through the runner', async () => {
    const runner = createTransmuxRunner({ disableWorker: true }, transmuxSource);
    const result = await runner.run(fixture('muxed-id3.m2ts'), 10);
    expect(result.metadata).toEqual(transmux(fixture('muxed-id3.m2ts'), 10).metadata);
    runner.dispose();
  });
});

describe('a segment cut mid-GOP', () => {
  it('drops without parameter sets to borrow', () => {
    const result = transmux(withoutParameterSets(fixture('muxed.m2ts')), 6, false, 'video');
    expect(result.bytes).toBeNull();
    expect(result.empty).toBe(true);
  });

  it('borrows the parameter sets the previous segment of its rendition had', () => {
    const previous = transmux(fixture('muxed.m2ts'), 0, false, 'video');
    expect(previous.parameterSets).not.toBeNull();
    const cut = withoutParameterSets(fixture('muxed.m2ts'));
    const borrowed = transmux(cut, 6, false, 'video', previous.parameterSets);
    expect(borrowed.bytes).not.toBeNull();
    expect(borrowed.parameterSets).toEqual(previous.parameterSets);
    // The init it writes is the one the intact segment writes: same sets, same avcC.
    const intact = transmux(fixture('muxed.m2ts'), 6, false, 'video').bytes as Uint8Array;
    const init = (bytes: Uint8Array) => bytes.slice(0, initLength(bytes));
    expect(Array.from(init(borrowed.bytes as Uint8Array))).toEqual(Array.from(init(intact)));
  });

  it('the runner carries the sets the caller hands it', async () => {
    const runner = createTransmuxRunner({ disableWorker: true }, transmuxSource);
    const previous = await runner.run(fixture('muxed.m2ts'), 0, false, 'video');
    const cut = withoutParameterSets(fixture('muxed.m2ts'));
    const borrowed = await runner.run(cut, 6, false, 'video', previous.parameterSets);
    expect(borrowed.bytes).not.toBeNull();
    runner.dispose();
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
/** Every baseMediaDecodeTime of the fragment, in track order. */
function tfdts(data: Uint8Array): number[] {
  const bases: number[] = [];
  walkBoxes(data, (box) => {
    if (box.path === 'moof/traf' && box.type === 'tfdt') {
      const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
      bases.push(view.getUint32(4) * 0x1_0000_0000 + view.getUint32(8));
    }
    return true;
  });
  return bases;
}

/** The number of samples in the fragment's trun boxes. */
function sampleCount(data: Uint8Array): number {
  let count = 0;
  walkBoxes(data, (box) => {
    if (box.path === 'moof/traf' && box.type === 'trun') {
      count += new DataView(box.payload.buffer, box.payload.byteOffset).getUint32(4);
    }
    return true;
  });
  return count;
}
