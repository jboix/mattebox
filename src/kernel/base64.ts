/**
 * Byte encodings, one copy each: base64 (RFC 4648 §4) and base64url (§5)
 * for manifest pssh boxes and license bodies, and hex for codec strings,
 * session ids, and readable metadata.
 */

/** Base64 text into bytes, whitespace ignored; null when it is not base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Bytes into base64, or into unpadded base64url when `url` is set. */
export function bytesToBase64(bytes: Uint8Array, url = false): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const text = btoa(binary);
  return url ? text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : text;
}

/** A byte as two lowercase hex digits. */
export function byteToHex(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, '0');
}

/** Bytes as lowercase hex, two digits each. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byteToHex(byte);
  return out;
}
