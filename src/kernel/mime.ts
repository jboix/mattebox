/**
 * MIME type normalization, shared by the composition root, the reducer, and
 * the protocol adapters. A caller's `mimeType` hint and a server's
 * Content-Type header both arrive with arbitrary case and optional
 * parameters (`; charset=utf-8`); every comparison in the engine runs on the
 * normalized form so `Application/X-MPEGURL` and `application/x-mpegurl`
 * name the same format.
 */

/** Lowercases a MIME type and drops its parameters. Whitespace is trimmed. */
export function normalizeMimeType(value: string): string {
  const semicolon = value.indexOf(';');
  return (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
}

/** The full MSE type for a MIME type and its codecs: `video/mp4; codecs="avc1.42c01e"`, or the bare MIME type. */
export function typeString(mimeType: string, codecs: string | null): string {
  return codecs === null ? mimeType : `${mimeType}; codecs="${codecs}"`;
}

/** True for a capability string that names a manifest format: a MIME type, the only capability strings containing '/'. */
export function isManifestType(capability: string): boolean {
  return capability.includes('/');
}
