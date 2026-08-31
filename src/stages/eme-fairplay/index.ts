/**
 * FairPlay Streaming: the non-standard SPC/CKC flow. Safari only, and it
 * differs from CENC enough to warrant its own stage — the CDM message is
 * an SPC to POST as form data, the response is a CKC, and the content id
 * comes from the skd:// URI the hls parser stored in licenseUrl. Registers
 * a handler; eme-core drives it, including the certificate fetch.
 */
import type { Stage } from '../../types/stage.js';
import { registerKeySystem } from '../drm-shared.js';

const FAIRPLAY_SYSTEM_ID = '94ce86fb-07ff-4f43-adb8-93d2fa968ca2';

/** The content id from a skd:// init data blob: the URI's opaque tail. */
export function contentIdFromSkd(initData: ArrayBuffer): string {
  const text = new TextDecoder().decode(initData);
  const match = /skd:\/\/(.+)$/.exec(text.trim());
  return match !== null ? (match[1] as string) : text.trim();
}

/** Wraps the SPC as the `spc=` form body Apple's key servers expect. */
export function buildSpcRequest(message: ArrayBuffer): Uint8Array {
  let binary = '';
  for (const b of new Uint8Array(message)) binary += String.fromCharCode(b);
  const spc = btoa(binary);
  return new TextEncoder().encode(`spc=${encodeURIComponent(spc)}`);
}

/** Decodes a CKC form/base64 response into the bytes session.update wants. */
export function parseCkcResponse(response: ArrayBuffer): ArrayBuffer | Uint8Array {
  const text = new TextDecoder().decode(response).trim();
  // A base64 or `ckc=<base64>` body; a binary body passes through.
  const b64 = /^ckc=(.+)$/.exec(text)?.[1] ?? (/^[A-Za-z0-9+/=]+$/.test(text) ? text : null);
  if (b64 === null) return response;
  try {
    const binary = atob(decodeURIComponent(b64));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return response;
  }
}

export interface FairPlayOptions {
  /** The FairPlay application certificate URL; required for a real handshake. */
  readonly certificateUrl?: string;
}

export default function emeFairplay(options: FairPlayOptions = {}): Stage {
  return {
    name: 'eme-fairplay',
    provides: ['eme-fairplay'],
    requires: ['eme-core'],
    install() {
      registerKeySystem({
        keySystem: 'com.apple.fps',
        systemIds: [FAIRPLAY_SYSTEM_ID],
        initDataTypes: ['sinf', 'skd'],
        licenseHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
        buildLicenseRequest: buildSpcRequest,
        parseLicenseResponse: parseCkcResponse,
        fairplay: {
          ...(options.certificateUrl !== undefined
            ? { certificateUrl: options.certificateUrl }
            : {}),
          contentId: contentIdFromSkd,
        },
      });
      return undefined;
    },
  };
}
