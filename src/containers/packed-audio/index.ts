/**
 * Packed audio: a raw AAC HLS segment, sometimes with a leading ID3 tag, that
 * MSE cannot accept directly. This is the actual Apple bipbop `gear0` case,
 * an audio-only elementary stream with no container at all. The stage wraps
 * the ADTS frames in an fMP4 with sample-accurate timing from the frame count,
 * sharing the fMP4 writer with ts-transmux. No Worker: audio-only wrapping is
 * light, and the frames are already the payload.
 */
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';
import { parseAdts, SAMPLES_PER_FRAME } from '../adts.js';
import {
  type AudioTrackConfig,
  type Sample,
  writeInitSegment,
  writeMediaSegment,
} from '../fmp4/writer.js';
import { id3TagLength } from '../id3.js';

const AUDIO_TRACK_ID = 1;
const PACK_ORDER = 100;

/** True when the bytes are bare ADTS AAC, past any leading ID3 tag. */
export function looksLikePackedAudio(data: Uint8Array): boolean {
  const offset = id3TagLength(data, 0);
  return (
    offset + 2 <= data.byteLength &&
    data[offset] === 0xff &&
    ((data[offset + 1] as number) & 0xf6) === 0xf0
  );
}

/** Wraps one packed-audio segment as a self-contained fMP4. Null if unparseable. */
export function packAudio(data: Uint8Array, presentationStart: number): Uint8Array | null {
  const offset = id3TagLength(data, 0);
  const adts = parseAdts(data.subarray(offset));
  if (adts.frames.length === 0) return null;
  const config: AudioTrackConfig = {
    id: AUDIO_TRACK_ID,
    kind: 'audio',
    timescale: adts.sampleRate,
    audioObjectType: adts.audioObjectType,
    samplingFrequencyIndex: adts.samplingFrequencyIndex,
    channelConfig: adts.channelConfig,
  };
  const samples: Sample[] = adts.frames.map((frame) => ({
    data: frame.data,
    duration: SAMPLES_PER_FRAME,
    cts: 0,
    isKeyframe: true,
  }));
  const base = Math.round(presentationStart * adts.sampleRate);
  const sequenceNumber = Math.max(1, Math.round(presentationStart) + 1);
  const init = writeInitSegment([config]);
  const media = writeMediaSegment(sequenceNumber, [
    { trackId: AUDIO_TRACK_ID, baseMediaDecodeTime: base, samples },
  ]);
  const out = new Uint8Array(init.byteLength + media.byteLength);
  out.set(init, 0);
  out.set(media, init.byteLength);
  return out;
}

export default function packedAudio(): Stage {
  return {
    name: 'packed-audio',
    provides: ['packed-audio', 'media-transform', 'media-time-normalized'],
    install(ctx) {
      ctx.registerTransform({
        name: 'packed-audio',
        order: PACK_ORDER,
        transform(data: Uint8Array, meta: SegmentMeta): Uint8Array {
          if (meta.contentType !== 'audio') return data;
          if (!looksLikePackedAudio(data)) return data;
          return packAudio(data, meta.start) ?? data;
        },
      });
    },
  };
}
