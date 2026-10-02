import { describe, expect, it } from 'vitest';
import { id3Cues, id3Events, id3TagLength, parseId3Frames } from '../../../src/containers/id3.js';
import { looksLikePackedAudio, packAudio } from '../../../src/containers/packed-audio/index.js';

/** Builds a minimal ID3v2.4 tag holding one TXXX-style text frame. */
function id3Tag(frameId: string, text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const frame = new Uint8Array(10 + 1 + body.byteLength);
  frame.set(
    [...frameId].map((c) => c.charCodeAt(0)),
    0,
  );
  const frameSize = 1 + body.byteLength;
  // Synchsafe frame size (each byte holds 7 bits).
  frame[4] = (frameSize >> 21) & 0x7f;
  frame[5] = (frameSize >> 14) & 0x7f;
  frame[6] = (frameSize >> 7) & 0x7f;
  frame[7] = frameSize & 0x7f;
  frame[10] = 0x03; // UTF-8 encoding byte
  frame.set(body, 11);

  const tag = new Uint8Array(10 + frame.byteLength);
  tag.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00], 0); // "ID3", v2.4.0, no flags
  const size = frame.byteLength;
  tag[6] = (size >> 21) & 0x7f;
  tag[7] = (size >> 14) & 0x7f;
  tag[8] = (size >> 7) & 0x7f;
  tag[9] = size & 0x7f;
  tag.set(frame, 10);
  return tag;
}

describe('ID3 framing', () => {
  it('measures a tag length and parses its frames', () => {
    const tag = id3Tag('TIT2', 'Now Playing');
    expect(id3TagLength(tag)).toBe(tag.byteLength);
    const frames = parseId3Frames(tag);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe('TIT2');
  });

  it('reports zero length for non-ID3 bytes rather than reading past the buffer', () => {
    expect(id3TagLength(new Uint8Array([0xff, 0xf1, 0, 0]))).toBe(0);
    expect(parseId3Frames(new Uint8Array(4))).toEqual([]);
  });

  it('turns frames into zero-length metadata cues at the presentation time', () => {
    const tag = id3Tag('TIT2', 'Chapter One');
    const cues = id3Cues(tag, 12.5);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.start).toBe(12.5);
    expect(cues[0]?.end).toBe(12.5);
    const payload = cues[0]?.payload as { key: string; value: string };
    expect(payload.key).toBe('TIT2');
    expect(payload.value).toBe('Chapter One');
  });
});

describe('ID3 tags as timed-metadata records', () => {
  it('splits a TXXX frame into its description and value', () => {
    const [event] = id3Events([{ time: 4.25, bytes: id3Tag('TXXX', 'source\0camera 2') }]);
    expect(event).toMatchObject({ id: 'id3@4250#0', source: 'id3', start: 4.25, end: 4.25 });
    expect(event?.frames?.[0]).toMatchObject({
      id: 'TXXX',
      description: 'source',
      value: 'camera 2',
    });
    expect(id3Cues(id3Tag('TXXX', 'source\0camera 2'), 0)[0]?.payload).toMatchObject({
      value: 'camera 2',
      description: 'source',
    });
  });

  it('numbers tags that share a time, so a refetched segment yields the same ids', () => {
    const tags = [
      { time: 1, bytes: id3Tag('TIT2', 'a') },
      { time: 1, bytes: id3Tag('TIT2', 'b') },
      { time: 2, bytes: id3Tag('TIT2', 'c') },
    ];
    expect(id3Events(tags).map((e) => e.id)).toEqual(['id3@1000#0', 'id3@1000#1', 'id3@2000#0']);
    expect(id3Events(tags)).toEqual(id3Events(tags));
  });

  it('decodes UTF-16 text with either byte order', () => {
    const tag = id3Tag('TIT2', '');
    const frames = (body: number[]) =>
      id3Events([{ time: 0, bytes: withBody(tag, body) }])[0]?.frames?.[0]?.value;
    // "hé" as UTF-16 with a big-endian mark, then as UTF-16BE without one.
    expect(frames([0x01, 0xfe, 0xff, 0x00, 0x68, 0x00, 0xe9])).toBe('hé');
    expect(frames([0x02, 0x00, 0x68, 0x00, 0xe9])).toBe('hé');
    expect(frames([0x01, 0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00])).toBe('hé');
    expect(frames([0x00, 0x68, 0xe9])).toBe('hé');
  });
});

/** The tag with its one frame's body replaced, sizes updated. */
function withBody(tag: Uint8Array, body: number[]): Uint8Array {
  const id = [...tag.subarray(10, 14)];
  const frame = [...id, 0, 0, 0, body.length, 0, 0, ...body];
  return Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, frame.length, ...frame]);
}

describe('packed audio with a leading ID3 tag', () => {
  it('sniffs past the tag and wraps the ADTS that follows', () => {
    // One ID3 tag, then a single silent ADTS frame (7-byte header + payload).
    const tag = id3Tag('TXXX', 'meta');
    const adts = new Uint8Array([0xff, 0xf1, 0x50, 0x40, 0x01, 0x40, 0x00, 0x00, 0x00, 0x00]);
    const segment = new Uint8Array(tag.byteLength + adts.byteLength);
    segment.set(tag, 0);
    segment.set(adts, tag.byteLength);
    expect(looksLikePackedAudio(segment)).toBe(true);
    // The wrap skips the tag and finds the frame; the output is a valid fMP4.
    const out = packAudio(segment, 0);
    expect(out).not.toBeNull();
    expect(out?.byteLength).toBeGreaterThan(adts.byteLength);
  });
});
