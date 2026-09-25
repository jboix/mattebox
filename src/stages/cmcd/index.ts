/**
 * Common Media Client Data (CTA-5004). The engine already exposes the seam
 * this needs: a request hook that sees every outgoing segment and manifest
 * URL. This stage reads playback state through the stage context and appends
 * the CMCD keys a CDN reads to understand the session, as either a query
 * argument or request headers.
 *
 * It computes nothing the kernel does not already track: the active rendition
 * bitrate, the measured throughput EWMA, and the buffer ahead of the playhead
 * from the media element. No new kernel state, no new effect.
 */
import type { Stage } from '../../types/stage.js';

export interface CmcdOptions {
  /** A stable content id, echoed as `cid`. */
  readonly contentId?: string;
  /** 'query' appends a CMCD argument to the URL; 'header' sends CMCD-* headers. */
  readonly mode?: 'query' | 'header';
  /** Overrides the generated session id, echoed as `sid`. */
  readonly sessionId?: string;
}

/** The CMCD object type, inferred from the URL the request is fetching. */
function objectType(url: string): string {
  if (/\.(m3u8|mpd)(\?|$)/i.test(url)) return 'm';
  if (/\.(vtt|srt)(\?|$)/i.test(url)) return 'c';
  if (/\.(aac|mp3|ac3|m4a)(\?|$)/i.test(url)) return 'a';
  return 'av';
}

/** CMCD keys whose value is an enumerated token, sent unquoted. */
const TOKEN_KEYS: ReadonlySet<string> = new Set(['ot', 'sf', 'st']);

/**
 * Serializes CMCD keys per CTA-5004: sorted, booleans bare, tokens unquoted,
 * and true strings (sid, cid) quoted.
 */
function serialize(keys: Record<string, string | number | boolean>): string {
  return Object.keys(keys)
    .sort()
    .map((key) => {
      const value = keys[key];
      if (value === true) return key;
      if (typeof value === 'string') {
        return TOKEN_KEYS.has(key) ? `${key}=${value}` : `${key}=${JSON.stringify(value)}`;
      }
      return `${key}=${value}`;
    })
    .join(',');
}

/**
 * A version 4 UUID for `sid` (CTA-5004 recommends a UUID). randomUUID
 * exists only in secure contexts, so plain-HTTP pages build one from
 * getRandomValues, which every context has (RFC 9562 §5.4).
 */
function sessionUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function cmcd(options: CmcdOptions = {}): Stage {
  const sessionId = options.sessionId ?? sessionUuid();
  const mode = options.mode ?? 'query';

  return {
    name: 'cmcd',
    provides: ['cmcd'],
    requires: ['transport'],
    install(ctx) {
      ctx.addRequestHook((req) => {
        const state = ctx.getState();
        const keys: Record<string, string | number | boolean> = {
          sid: sessionId,
          ot: objectType(req.url),
        };
        if (options.contentId !== undefined) keys.cid = options.contentId;

        // Encoded bitrate of the active rendition, in kbps.
        const activeId = state.quality.active;
        if (activeId !== null && state.presentation !== null) {
          for (const period of state.presentation.periods) {
            for (const track of period.tracks) {
              const rendition = track.renditions.find((r) => r.id === activeId);
              if (rendition !== undefined) keys.br = Math.round(rendition.bitrate / 1000);
            }
          }
        }

        // Measured throughput EWMA, in kbps, rounded to the spec's 100 kbps.
        const mtp = state.stats.throughputEwma;
        if (mtp > 0) keys.mtp = Math.round(mtp / 1000 / 100) * 100;

        // Buffer ahead of the playhead, in ms, from the element.
        const el = ctx.element;
        const ahead = bufferAhead(el);
        if (ahead !== null) keys.bl = Math.round((ahead * 1000) / 100) * 100;
        if (ahead !== null && ahead < 1) keys.su = true;

        const payload = serialize(keys);
        if (mode === 'header') {
          req.headers['CMCD-Request'] = payload;
        } else {
          const separator = req.url.includes('?') ? '&' : '?';
          req.url = `${req.url}${separator}CMCD=${encodeURIComponent(payload)}`;
        }
      });
    },
  };
}

function bufferAhead(el: HTMLMediaElement): number | null {
  const { buffered, currentTime } = el;
  for (let i = 0; i < buffered.length; i += 1) {
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
      return buffered.end(i) - currentTime;
    }
  }
  return null;
}
