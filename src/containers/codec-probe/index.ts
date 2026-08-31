/**
 * Derives the exact codecs= string from an init segment's moov. Manifests
 * routinely omit or misstate CODECS, and isTypeSupported wants exact
 * strings; when the manifest and the probe disagree, the probe wins,
 * because the probe read the actual bytes the decoder will see.
 */
import type { MatteboxError } from '../../types/error.js';
import type { BoxRef } from '../mp4-box/index.js';
import { findBoxes, fullBox, walkBoxes } from '../mp4-box/index.js';

export interface ProbedTrack {
  /** The stsd sample entry fourcc, such as 'avc1' or 'mp4a'. */
  readonly format: string;
  /** The derived RFC 6381 codec string, or null when underivable. */
  readonly codec: string | null;
  readonly kind: 'video' | 'audio' | 'unknown';
}

export interface ProbeResult {
  readonly tracks: readonly ProbedTrack[];
  readonly codecs: readonly string[];
  /** Ready for isTypeSupported, or null when nothing was derivable. */
  readonly mimeType: string | null;
  readonly error: MatteboxError | null;
}

const VIDEO_FORMATS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
const AUDIO_FORMATS = new Set(['mp4a', 'Opus', 'opus', 'ac-3', 'ec-3']);

/** Sample entry fixed-part sizes before the codec config child boxes. */
const VISUAL_ENTRY_HEADER = 8 + 70;
const AUDIO_ENTRY_HEADER = 8 + 20;

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

function childBox(entry: Uint8Array, fixedOffset: number, type: string): Uint8Array | null {
  // Child boxes start after the sample entry's fixed part. A malformed or
  // versioned entry shifts them; scan forward conservatively.
  for (const offset of [fixedOffset, fixedOffset + 16]) {
    let at = offset;
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    while (at + 8 <= entry.byteLength) {
      const size = view.getUint32(at);
      if (size < 8 || at + size > entry.byteLength) break;
      const name = String.fromCharCode(
        entry[at + 4] ?? 0,
        entry[at + 5] ?? 0,
        entry[at + 6] ?? 0,
        entry[at + 7] ?? 0,
      );
      if (name === type) return entry.subarray(at + 8, at + size);
      at += size;
    }
  }
  return null;
}

/** avcC: profile, constraint flags, level -> avc1.PPCCLL. ISO 14496-15 §5.3. */
function avcCodec(format: string, entry: Uint8Array): string | null {
  const config = childBox(entry, VISUAL_ENTRY_HEADER, 'avcC');
  if (config === null || config.byteLength < 4) return null;
  return `${format}.${hex(config[1] as number)}${hex(config[2] as number)}${hex(config[3] as number)}`;
}

/** hvcC -> the full hvc1/hev1 form. ISO 14496-15 annex E. */
function hevcCodec(format: string, entry: Uint8Array): string | null {
  const c = childBox(entry, VISUAL_ENTRY_HEADER, 'hvcC');
  if (c === null || c.byteLength < 13) return null;
  const profileSpace = ((c[1] as number) >> 6) & 0x3;
  const tier = ((c[1] as number) >> 5) & 0x1;
  const profileIdc = (c[1] as number) & 0x1f;
  const compat =
    ((c[2] as number) << 24) |
    ((c[3] as number) << 16) |
    ((c[4] as number) << 8) |
    (c[5] as number);
  // The compatibility flags are written bit-reversed in the codec string.
  let reversed = 0;
  for (let i = 0; i < 32; i += 1) {
    reversed = (reversed << 1) | ((compat >>> i) & 1);
  }
  const levelIdc = c[12] as number;
  const constraints: string[] = [];
  for (let i = 6; i < 12; i += 1) {
    constraints.push((c[i] as number).toString(16).toUpperCase());
  }
  while (constraints.length > 1 && constraints[constraints.length - 1] === '0') {
    constraints.pop();
  }
  const space = ['', 'A', 'B', 'C'][profileSpace] ?? '';
  return `${format}.${space}${profileIdc}.${(reversed >>> 0).toString(16).toUpperCase()}.${tier === 1 ? 'H' : 'L'}${levelIdc}.${constraints.join('.')}`;
}

/** esds -> mp4a.40.N via the DecoderSpecificInfo audio object type. ISO 14496-1 §7.2.6. */
function aacCodec(entry: Uint8Array): string | null {
  const esds = childBox(entry, AUDIO_ENTRY_HEADER, 'esds');
  if (esds === null) return null;
  const body = fullBox(esds)?.body;
  if (body === undefined) return null;

  // Descriptors: tag byte, then an expandable length (0x80-continued).
  function descriptor(data: Uint8Array, tag: number): Uint8Array | null {
    let at = 0;
    while (at + 2 <= data.byteLength) {
      const thisTag = data[at] as number;
      at += 1;
      let size = 0;
      let more = true;
      while (more && at < data.byteLength) {
        const byte = data[at] as number;
        size = (size << 7) | (byte & 0x7f);
        more = (byte & 0x80) !== 0;
        at += 1;
      }
      if (at + size > data.byteLength) return null;
      if (thisTag === tag) return data.subarray(at, at + size);
      at += size;
    }
    return null;
  }

  const es = descriptor(body, 0x03);
  if (es === null) return null;
  // ES_Descriptor: ES_ID (2) + flags byte, then optional fields none of
  // which appear in practice for CMAF.
  const decoderConfig = descriptor(es.subarray(3), 0x04);
  if (decoderConfig === null || decoderConfig.byteLength < 1) return null;
  const objectType = decoderConfig[0] as number;
  const specific = descriptor(decoderConfig.subarray(13), 0x05);
  if (objectType === 0x40 && specific !== null && specific.byteLength >= 1) {
    const audioObjectType = ((specific[0] as number) >> 3) & 0x1f;
    return `mp4a.40.${audioObjectType}`;
  }
  return `mp4a.${hex(objectType)}`;
}

/** vpcC -> vp09.PP.LL.DD. VP9-in-ISOBMFF binding. */
function vp9Codec(entry: Uint8Array): string | null {
  const c = childBox(entry, VISUAL_ENTRY_HEADER, 'vpcC');
  const body = c === null ? null : (fullBox(c)?.body ?? null);
  if (body === null || body.byteLength < 2) return null;
  const profile = body[0] as number;
  const level = body[1] as number;
  const bitDepth = ((body[2] ?? 8) >> 4) & 0xf;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `vp09.${pad(profile)}.${pad(level)}.${pad(bitDepth)}`;
}

/** av1C -> av01.P.LLT.DD. AV1-in-ISOBMFF binding. */
function av1Codec(entry: Uint8Array): string | null {
  const c = childBox(entry, VISUAL_ENTRY_HEADER, 'av1C');
  if (c === null || c.byteLength < 2) return null;
  const profile = ((c[1] as number) >> 5) & 0x7;
  const levelIdx = (c[1] as number) & 0x1f;
  const tier = ((c[2] ?? 0) >> 7) & 0x1;
  const highBitdepth = ((c[2] ?? 0) >> 6) & 0x1;
  const twelveBit = ((c[2] ?? 0) >> 5) & 0x1;
  const bitDepth = highBitdepth === 1 ? (twelveBit === 1 ? 12 : 10) : 8;
  return `av01.${profile}.${String(levelIdx).padStart(2, '0')}${tier === 1 ? 'H' : 'M'}.${String(bitDepth).padStart(2, '0')}`;
}

function deriveTrack(format: string, entry: Uint8Array): ProbedTrack {
  const kind = VIDEO_FORMATS.has(format)
    ? 'video'
    : AUDIO_FORMATS.has(format)
      ? 'audio'
      : 'unknown';
  let codec: string | null = null;
  switch (format) {
    case 'avc1':
    case 'avc3':
      codec = avcCodec(format, entry);
      break;
    case 'hvc1':
    case 'hev1':
      codec = hevcCodec(format, entry);
      break;
    case 'mp4a':
      codec = aacCodec(entry);
      break;
    case 'vp09':
      codec = vp9Codec(entry);
      break;
    case 'av01':
      codec = av1Codec(entry);
      break;
    case 'Opus':
    case 'opus':
      codec = 'opus';
      break;
    case 'ac-3':
      codec = 'ac-3';
      break;
    case 'ec-3':
      codec = 'ec-3';
      break;
    default:
      codec = null;
  }
  return { format, codec, kind };
}

/** Probes every stsd sample entry in the init segment's moov. */
export function probeInitSegment(init: Uint8Array): ProbeResult {
  const walk = walkBoxes(init, () => undefined);
  if (walk.error !== null) {
    return { tracks: [], codecs: [], mimeType: null, error: walk.error };
  }

  const tracks: ProbedTrack[] = [];
  const stsds: readonly BoxRef[] = findBoxes(init, 'moov/trak/mdia/minf/stbl/stsd');
  for (const stsd of stsds) {
    const header = fullBox(stsd.payload);
    if (header === null || header.body.byteLength < 4) continue;
    const view = new DataView(header.body.buffer, header.body.byteOffset, header.body.byteLength);
    const count = view.getUint32(0);
    let at = 4;
    for (let i = 0; i < count && at + 8 <= header.body.byteLength; i += 1) {
      const size = view.getUint32(at);
      if (size < 8 || at + size > header.body.byteLength) break;
      const format = String.fromCharCode(
        header.body[at + 4] ?? 0,
        header.body[at + 5] ?? 0,
        header.body[at + 6] ?? 0,
        header.body[at + 7] ?? 0,
      );
      tracks.push(deriveTrack(format, header.body.subarray(at + 8, at + size)));
      at += size;
    }
  }

  const codecs = tracks.map((t) => t.codec).filter((c): c is string => c !== null);
  const hasVideo = tracks.some((t) => t.kind === 'video');
  const mimeType =
    codecs.length === 0
      ? null
      : `${hasVideo ? 'video' : 'audio'}/mp4; codecs="${codecs.join(',')}"`;
  return { tracks, codecs, mimeType, error: null };
}

export interface CodecReconciliation {
  /** The string to hand to addSourceBuffer. */
  readonly contentType: string;
  /** True when the manifest and the probe disagreed; emit a warning. */
  readonly mismatch: boolean;
}

/**
 * The probe wins over the manifest: it read the bytes the decoder will
 * decode. The mismatch flag exists so the discrepancy stays visible.
 */
export function reconcileCodecs(
  manifestContentType: string | null,
  probe: ProbeResult,
): CodecReconciliation {
  if (probe.mimeType === null) {
    return { contentType: manifestContentType ?? '', mismatch: false };
  }
  if (manifestContentType === null) {
    return { contentType: probe.mimeType, mismatch: false };
  }
  const normalize = (s: string) => s.toLowerCase().replaceAll(/\s+/g, '');
  return {
    contentType: probe.mimeType,
    mismatch: normalize(manifestContentType) !== normalize(probe.mimeType),
  };
}
