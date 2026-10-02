/**
 * ID3v2 framing, shared by packed-audio (which skips the leading tag before
 * the ADTS frames) and meta-id3 (which turns the frames into metadata cues).
 * Living in the container layer keeps the stage from importing a sibling
 * stage. Every size read is synchsafe-aware and bounded by the buffer, so a
 * malformed tag reports the length it could trust rather than overrunning.
 */
import type { CueDescriptor, Serializable } from '../types/messages.js';
import type { Id3FrameView, MetadataEvent } from '../types/metadata.js';
import { fourcc } from './mp4-box/index.js';

const HEADER_SIZE = 10;

function isId3(data: Uint8Array, offset: number): boolean {
  return data[offset] === 0x49 && data[offset + 1] === 0x44 && data[offset + 2] === 0x33;
}

/** A 28-bit synchsafe integer: four bytes, seven bits each. */
function synchsafe(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) << 21) |
    ((data[offset + 1] ?? 0) << 14) |
    ((data[offset + 2] ?? 0) << 7) |
    (data[offset + 3] ?? 0)
  );
}

/** The full byte length of the ID3v2 tag at `offset`, or zero if none is there. */
export function id3TagLength(data: Uint8Array, offset = 0): number {
  if (offset + HEADER_SIZE > data.byteLength || !isId3(data, offset)) return 0;
  const size = synchsafe(data, offset + 6);
  const total = HEADER_SIZE + size;
  return offset + total <= data.byteLength ? total : 0;
}

/** One decoded ID3 frame: its four-character id and its raw payload bytes. */
export interface Id3Frame {
  readonly id: string;
  readonly data: Uint8Array;
}

function frameSize(data: Uint8Array, offset: number, major: number): number {
  // 2.4 uses synchsafe frame sizes; 2.3 uses a plain 32-bit big-endian size.
  if (major >= 4) return synchsafe(data, offset);
  return (
    ((data[offset] ?? 0) << 24) |
    ((data[offset + 1] ?? 0) << 16) |
    ((data[offset + 2] ?? 0) << 8) |
    (data[offset + 3] ?? 0)
  );
}

/** Parses the frames of one ID3v2 tag. Stops at padding or a bad frame. */
export function parseId3Frames(data: Uint8Array, offset = 0): Id3Frame[] {
  const total = id3TagLength(data, offset);
  if (total === 0) return [];
  const major = data[offset + 3] ?? 0;
  const frames: Id3Frame[] = [];
  let cursor = offset + HEADER_SIZE;
  const end = offset + total;
  while (cursor + 10 <= end) {
    const id = fourcc(data, cursor);
    // A zero id is padding: the frames are done.
    if (data[cursor] === 0) break;
    const size = frameSize(data, cursor + 4, major);
    if (size <= 0 || cursor + 10 + size > end) break;
    frames.push({ id, data: data.subarray(cursor + 10, cursor + 10 + size) });
    cursor += 10 + size;
  }
  return frames;
}

function decodeTextFrame(frame: Id3Frame): string {
  // Text frames lead with an encoding byte (ID3v2.4 §4.2): 0 is ISO-8859-1,
  // 1 is UTF-16 with a byte order mark, 2 is UTF-16BE, 3 is UTF-8.
  const encoding = frame.data[0] ?? 0;
  const body = frame.data.subarray(1);
  const bigEndian = encoding === 2 || (encoding === 1 && body[0] === 0xfe && body[1] === 0xff);
  const label = ['latin1', bigEndian ? 'utf-16be' : 'utf-16le', 'utf-16be', 'utf-8'][encoding];
  return new TextDecoder(label ?? 'utf-8').decode(body).replace(/\0+$/, '');
}

/**
 * Turns an ID3 tag's frames into metadata cues at `presentationTime`. Text
 * frames carry their decoded string; every frame keeps its raw bytes on the
 * payload so a consumer can read a format this decoder does not special-case.
 * The cues are zero-length, which is how timed metadata is represented.
 */
export function id3Cues(data: Uint8Array, presentationTime: number, offset = 0): CueDescriptor[] {
  const frames = parseId3Frames(data, offset);
  return frames.map((frame) => {
    const text = frameText(frame);
    const payload: Serializable = {
      key: frame.id,
      data: [...frame.data],
      ...(text !== undefined ? text : {}),
    };
    return { start: presentationTime, end: presentationTime, payload };
  });
}

/**
 * A text frame's string: the T frames and WXXX. TXXX and WXXX hold a
 * description, a null, then the value (ID3v2.4 §4.2.6, §4.3.2).
 */
function frameText(frame: Id3Frame): { value: string; description?: string } | undefined {
  if (!frame.id.startsWith('T') && frame.id !== 'WXXX') return undefined;
  const text = decodeTextFrame(frame).replace(/\uFEFF/g, '');
  if (frame.id !== 'TXXX' && frame.id !== 'WXXX') return { value: text };
  const split = text.indexOf('\0');
  if (split < 0) return { value: text };
  return { value: text.slice(split + 1), description: text.slice(0, split) };
}

/** An ID3 tag's frames as the page reads them: id, text when it is a text frame, bytes. */
export function id3Frames(tag: Uint8Array): Id3FrameView[] {
  return parseId3Frames(tag).map((frame) => ({
    id: frame.id,
    ...frameText(frame),
    data: frame.data,
  }));
}

/**
 * ID3 tags as timed-metadata records, one per tag. The id is the time in
 * milliseconds and the tag's place among tags at that time, so a segment
 * fetched again (a quality switch, a retry) yields the same ids.
 */
export function id3Events(
  tags: readonly { readonly time: number; readonly bytes: Uint8Array }[],
): MetadataEvent[] {
  const atTime = new Map<number, number>();
  return tags.map(({ time, bytes }) => {
    const ms = Math.round(time * 1000);
    const index = atTime.get(ms) ?? 0;
    atTime.set(ms, index + 1);
    return {
      id: `id3@${ms}#${index}`,
      source: 'id3',
      scheme: 'id3',
      start: time,
      end: time,
      attributes: {},
      data: bytes,
      frames: id3Frames(bytes),
    };
  });
}
