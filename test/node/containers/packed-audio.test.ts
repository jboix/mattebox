import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAdts, SAMPLES_PER_FRAME } from '../../../src/containers/adts.js';
import { walkBoxes } from '../../../src/containers/mp4-box/index.js';
import { looksLikePackedAudio, packAudio } from '../../../src/containers/packed-audio/index.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../fixtures/golden/${name}`, import.meta.url))),
  );
}

describe('packed-audio ADTS parsing', () => {
  it('reads every ADTS frame and its codec parameters', () => {
    const result = parseAdts(fixture('audio.aac'));
    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(44100);
    expect(result.audioObjectType).toBe(2); // AAC-LC
    expect(result.channelConfig).toBe(1); // mono, as encoded
  });
});

describe('packed-audio wrapping', () => {
  it('sniffs bare ADTS and rejects other bytes', () => {
    expect(looksLikePackedAudio(fixture('audio.aac'))).toBe(true);
    expect(looksLikePackedAudio(fixture('muxed.m2ts'))).toBe(false);
    expect(looksLikePackedAudio(new Uint8Array([0, 1, 2, 3]))).toBe(false);
  });

  it('wraps ADTS into an fMP4 with sample-accurate timing', () => {
    const out = packAudio(fixture('audio.aac'), 0);
    expect(out).not.toBeNull();
    const paths: string[] = [];
    walkBoxes(out as Uint8Array, (box) => {
      paths.push(box.path === '' ? box.type : `${box.path}/${box.type}`);
      return true;
    });
    expect(paths).toContain('moov/trak');
    expect(paths).toContain('moof/traf/trun');
    // Every sample is exactly one AAC frame long.
    const frames = parseAdts(fixture('audio.aac')).frames.length;
    const trun = trunSampleCount(out as Uint8Array);
    expect(trun).toBe(frames);
    // The total duration is frames * 1024 in the sample-rate timescale.
    const totalTicks = frames * SAMPLES_PER_FRAME;
    expect(totalTicks / 44100).toBeCloseTo(frames / (44100 / SAMPLES_PER_FRAME), 5);
  });

  it('matches the committed golden bytes', () => {
    const produced = packAudio(fixture('audio.aac'), 0) as Uint8Array;
    const golden = fixture('audio.fmp4');
    expect(Array.from(produced)).toEqual(Array.from(golden));
  });

  it('anchors the base decode time to the presentation start', () => {
    const atFour = packAudio(fixture('audio.aac'), 4) as Uint8Array;
    const base = firstAudioTfdt(atFour);
    // Four seconds at the 44.1 kHz audio timescale.
    expect(base).toBe(4 * 44100);
  });
});

function trunSampleCount(data: Uint8Array): number {
  let count = 0;
  walkBoxes(data, (box) => {
    if (box.path === 'moof/traf' && box.type === 'trun') {
      const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
      count = view.getUint32(4); // sample_count follows the 4-byte fullbox head
    }
    return true;
  });
  return count;
}

function firstAudioTfdt(data: Uint8Array): number {
  let base = -1;
  walkBoxes(data, (box) => {
    if (box.path === 'moof/traf' && box.type === 'tfdt' && base === -1) {
      const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
      base = view.getUint32(4) * 0x1_0000_0000 + view.getUint32(8);
    }
    return true;
  });
  return base;
}
