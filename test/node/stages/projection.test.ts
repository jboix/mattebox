import { describe, expect, it } from 'vitest';
import projection from '../../../src/stages/projection/index.js';
import type { Rendition } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

/** An init segment whose avc1 entry carries Apple's vexu/proj/prji of kind `equi`. */
function equirectangular(): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
    const size = 8 + parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(
      Uint8Array.from(type, (c) => c.charCodeAt(0)),
      4,
    );
    let at = 8;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  };
  const text = (value: string) => Uint8Array.from(value, (c) => c.charCodeAt(0));
  const prji = box('prji', new Uint8Array(4), text('equi'));
  const entry = box('avc1', new Uint8Array(78), box('vexu', box('proj', prji)));
  const stsd = box('stsd', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), entry);
  const hdlr = box('hdlr', new Uint8Array(8), text('vide'), new Uint8Array(13));
  return box('moov', box('trak', box('mdia', hdlr, box('minf', box('stbl', stsd)))));
}

function install(stated?: Rendition['projection']) {
  const dispatched: Command[] = [];
  let step: TransformStep | null = null;
  const rendition = {
    id: 'v1',
    bitrate: 1,
    codecs: 'avc1.640028',
    mimeType: 'video/mp4',
    segments: [],
    ...(stated !== undefined ? { projection: stated } : {}),
  };
  const state = {
    presentation: {
      id: 'p',
      isLive: false,
      couplings: [],
      periods: [
        {
          id: 'p0',
          start: 0,
          tracks: [
            {
              id: 'video',
              contentType: 'video',
              mimeType: 'video/mp4',
              protection: null,
              renditions: [rendition],
            },
          ],
        },
      ],
    },
  } as unknown as KernelState;
  projection().install({
    registerTransform: (s: TransformStep) => {
      step = s;
    },
    getState: () => state,
    dispatch: (command: Command) => dispatched.push(command),
  } as unknown as StageContext);
  const run = (bytes: Uint8Array, meta: Partial<SegmentMeta> = {}) =>
    (step as unknown as TransformStep).transform(bytes, {
      trackId: 'video',
      renditionId: 'v1',
      contentType: 'video',
      seq: -1,
      start: 0,
      duration: 0,
      isInit: true,
      ...meta,
    });
  return { dispatched, run };
}

describe('projection stage', () => {
  it("hands the init segment's projection to the kernel, and passes the bytes on", () => {
    const { dispatched, run } = install();
    const bytes = equirectangular();
    expect(run(bytes)).toBe(bytes);
    expect(dispatched).toEqual([
      { type: 'SET_PROJECTION', renditionId: 'v1', projection: 'equirectangular' },
    ]);
  });

  it('reads nothing where the manifest states a projection, for media segments, or for audio', () => {
    const stated = install('half-equirectangular');
    stated.run(equirectangular());
    expect(stated.dispatched).toEqual([]);
    const other = install();
    other.run(equirectangular(), { isInit: false, seq: 3 });
    other.run(equirectangular(), { contentType: 'audio' });
    other.run(equirectangular(), { renditionId: 'unknown' });
    expect(other.dispatched).toEqual([]);
  });
});
