/**
 * Common Media Server Data (CTA-5006): what the CDN says about the
 * delivery, read from each response's `CMSD-Dynamic` header. Two keys feed
 * the engine:
 *
 * - `etp`, the server's throughput estimate in kbps, becomes a throughput
 *   hint: ABR takes the lower of it and its own measurement, and it alone
 *   before the engine has measured anything.
 * - `mb`, the maximum bitrate the server suggests in kbps, becomes the
 *   `cmsd` constraint source (`maxBitrate`).
 *
 * The header is a Structured Field list (RFC 8941) to which each server on
 * the path appends; the last member is the one nearest the client, and the
 * one read. A response without the header changes nothing; a header without
 * a key clears that key. Cross-origin, the browser shows the header only
 * when the CDN lists it in `Access-Control-Expose-Headers`.
 */
import type { Stage } from '../../types/stage.js';

/** Splits on commas or semicolons outside double quotes. */
function split(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** The numeric parameters of the list's last member: `"CDN-B";etp=480;mb=6000`. */
export function cmsdParams(header: string): Map<string, number> {
  const members = split(header, ',');
  const last = members[members.length - 1] ?? '';
  const params = new Map<string, number>();
  for (const param of split(last, ';').slice(1)) {
    const [key, value] = param.trim().split('=') as [string, string | undefined];
    const number = value === undefined ? Number.NaN : Number(value);
    if (Number.isFinite(number)) params.set(key, number);
  }
  return params;
}

export default function cmsd(): Stage {
  return {
    name: 'cmsd',
    provides: ['cmsd'],
    requires: ['transport', 'rendition-select'],
    install(ctx) {
      let etp: number | null = null;
      let mb: number | null = null;
      ctx.addResponseHook((response) => {
        const header =
          response.outcome === 'success' ? response.headers?.get('CMSD-Dynamic') : null;
        if (header === null || header === undefined) return;
        const params = cmsdParams(header);
        const kbps = (key: string): number | null => {
          const value = params.get(key);
          return value !== undefined && value > 0 ? value * 1000 : null;
        };
        const nextEtp = kbps('etp');
        if (nextEtp !== etp) {
          etp = nextEtp;
          ctx.dispatch({ type: 'THROUGHPUT_HINT', bps: etp });
        }
        const nextMb = kbps('mb');
        if (nextMb !== mb) {
          mb = nextMb;
          ctx.dispatch(
            mb === null
              ? { type: 'RELEASE_CONSTRAINT', source: 'cmsd' }
              : { type: 'CONSTRAIN', source: 'cmsd', constraint: { maxBitrate: mb } },
          );
        }
      });
    },
  };
}
