/**
 * aes-128 as a stage: full-segment AES-CBC decryption for HLS EXT-X-KEY
 * METHOD=AES-128 (RFC 8216 §4.3.2.4). One transform step, ordered ahead of
 * every container step, so the transmux and the probe only ever see clear
 * bytes. Keys are fetched through the transport's request path and cached
 * by URL; the IV is the playlist's or, absent one, the media sequence
 * number. SAMPLE-AES is not this: it decrypts inside the elementary stream
 * and stays deferred (docs/16).
 */
import type { Segment, SegmentKey } from '../../types/ir.js';
import type { KernelState } from '../../types/kernel.js';
import type { Stage } from '../../types/stage.js';

/** Before the transmux (100) and the codec probe (5), which must read clear bytes. */
const DECRYPT_ORDER = 1;

/** The 16-byte IV: the explicit hex one, or the sequence number big-endian. */
export function ivFor(key: SegmentKey, seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  if (key.iv !== undefined) {
    const hex = key.iv.slice(-32).padStart(32, '0');
    for (let i = 0; i < 16; i += 1) iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return iv;
  }
  const view = new DataView(iv.buffer);
  view.setUint32(8, Math.floor(seq / 2 ** 32));
  view.setUint32(12, seq >>> 0);
  return iv;
}

function findSegment(
  state: Readonly<KernelState>,
  renditionId: string,
  seq: number,
): Segment | null {
  if (state.presentation === null || renditionId === '') return null;
  for (const period of state.presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id !== renditionId || !Array.isArray(rendition.segments)) continue;
        return rendition.segments.find((segment) => segment.seq === seq) ?? null;
      }
    }
  }
  return null;
}

export default function aes128(): Stage {
  return {
    name: 'aes-128',
    // media-transform routes appends through the pipeline; the step itself
    // leaves timing alone, so it is not media-time-normalized.
    provides: ['aes-128', 'media-transform'],
    install(ctx) {
      const keys = new Map<string, Promise<CryptoKey>>();

      function keyFor(uri: string): Promise<CryptoKey> {
        let pending = keys.get(uri);
        if (pending === undefined) {
          pending = ctx
            .request(uri, {})
            .then(async (response) => {
              if (!response.ok) throw new Error(`key fetch failed: HTTP ${response.status}`);
              const raw = await response.arrayBuffer();
              if (raw.byteLength !== 16) throw new Error(`key is ${raw.byteLength} bytes, not 16`);
              return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
            })
            .catch((err: unknown) => {
              // A failed fetch is not cached: the next segment retries it.
              keys.delete(uri);
              throw err;
            });
          keys.set(uri, pending);
        }
        return pending;
      }

      ctx.registerTransform({
        name: 'aes-128',
        order: DECRYPT_ORDER,
        async transform(data, meta) {
          const segment = findSegment(ctx.getState(), meta.renditionId, meta.seq);
          const key = segment?.key;
          if (key === undefined) return data;
          const cryptoKey = await keyFor(key.uri);
          const clear = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: ivFor(key, meta.seq) as BufferSource },
            cryptoKey,
            data as BufferSource,
          );
          return new Uint8Array(clear);
        },
      });
      return () => keys.clear();
    },
  };
}
