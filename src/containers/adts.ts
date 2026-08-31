/**
 * ADTS AAC framing. Both ts-transmux (AAC inside a TS PES) and packed-audio
 * (a bare .aac HLS segment) meet AAC as ADTS frames and need the same three
 * things: the raw AAC payloads for the mdat, the codec parameters for the
 * esds, and the sample count for timing. This is the shared module both
 * import; neither imports the other.
 */

/** The MPEG-4 sampling frequency table, indexed by samplingFrequencyIndex. */
export const SAMPLE_RATES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Samples per AAC frame; fixed for AAC-LC. */
export const SAMPLES_PER_FRAME = 1024;

export interface AdtsFrame {
  /** The raw AAC access unit, ADTS header removed. */
  readonly data: Uint8Array;
  readonly audioObjectType: number;
  readonly samplingFrequencyIndex: number;
  readonly channelConfig: number;
}

export interface AdtsResult {
  readonly frames: readonly AdtsFrame[];
  readonly sampleRate: number;
  readonly audioObjectType: number;
  readonly samplingFrequencyIndex: number;
  readonly channelConfig: number;
}

/**
 * Parses every ADTS frame in a buffer. Each frame header carries its own
 * length, so parsing walks frame to frame; a bad or truncated header stops
 * the walk rather than throwing. The returned codec parameters come from the
 * first valid frame, which is what the init segment describes.
 */
export function parseAdts(data: Uint8Array): AdtsResult {
  const frames: AdtsFrame[] = [];
  let audioObjectType = 2;
  let samplingFrequencyIndex = 4;
  let channelConfig = 2;
  let offset = 0;
  const length = data.byteLength;
  while (offset + 7 <= length) {
    // Syncword: eleven set bits across the first byte and the top of the second.
    if (data[offset] !== 0xff || ((data[offset + 1] as number) & 0xf6) !== 0xf0) {
      offset += 1;
      continue;
    }
    const protectionAbsent = (data[offset + 1] as number) & 0x01;
    const profile = ((data[offset + 2] as number) >> 6) & 0x03;
    const freqIndex = ((data[offset + 2] as number) >> 2) & 0x0f;
    const channels =
      (((data[offset + 2] as number) & 0x01) << 2) | (((data[offset + 3] as number) >> 6) & 0x03);
    const frameLength =
      (((data[offset + 3] as number) & 0x03) << 11) |
      ((data[offset + 4] as number) << 3) |
      (((data[offset + 5] as number) >> 5) & 0x07);
    if (frameLength < 7 || offset + frameLength > length) break;
    const headerSize = protectionAbsent ? 7 : 9;
    if (headerSize < frameLength) {
      frames.push({
        data: data.subarray(offset + headerSize, offset + frameLength),
        audioObjectType: profile + 1,
        samplingFrequencyIndex: freqIndex,
        channelConfig: channels,
      });
      if (frames.length === 1) {
        audioObjectType = profile + 1;
        samplingFrequencyIndex = freqIndex;
        channelConfig = channels;
      }
    }
    offset += frameLength;
  }
  return {
    frames,
    sampleRate: SAMPLE_RATES[samplingFrequencyIndex] ?? 44100,
    audioObjectType,
    samplingFrequencyIndex,
    channelConfig,
  };
}
