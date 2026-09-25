/**
 * What both manifest adapters share: the parse result shape, the parse
 * error, URL resolution, and the step that turns fetched manifest bytes
 * into a MANIFEST_LOADED or MANIFEST_FAILED fact.
 */
import type { MatteboxError } from '../types/error.js';
import type { Presentation } from '../types/ir.js';
import type { Message } from '../types/messages.js';

/** A parse either yields a presentation or says why not. */
export type ParseResult =
  | { readonly presentation: Presentation; readonly error: null }
  | { readonly presentation: null; readonly error: MatteboxError };

export function manifestError(reason: string): MatteboxError {
  return {
    category: 'manifest',
    code: 'MANIFEST_PARSE_FAILED',
    fatal: true,
    recoverable: false,
    context: { reason },
  };
}

/** A manifest URI made absolute against its document; an unparsable one stays as written. */
export function resolve(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/**
 * The fact for fetched manifest bytes, or null when this adapter does not
 * claim them. Declining emits nothing; the kernel reports bytes nobody claims.
 */
export function manifestFact(
  bytes: ArrayBuffer,
  url: string,
  claims: (text: string) => boolean,
  parse: (text: string, url: string) => ParseResult,
): Message | null {
  const text = new TextDecoder().decode(bytes);
  if (!claims(text)) return null;
  const result = parse(text, url);
  return result.presentation === null
    ? { type: 'MANIFEST_FAILED', error: result.error }
    : { type: 'MANIFEST_LOADED', presentation: result.presentation };
}
