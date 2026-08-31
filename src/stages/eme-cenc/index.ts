/**
 * Widevine and PlayReady over Common Encryption. Neither drives EME
 * itself: each registers a key-system handler that eme-core negotiates and
 * runs. The system-id UUIDs the dash parser already extracts, and the
 * skd/pssh the hls parser stores, select the branch; the shaping here is
 * the request body and the response unwrap each server expects.
 */
import type { Stage } from '../../types/stage.js';
import { registerKeySystem } from '../drm-shared.js';

const WIDEVINE_SYSTEM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY_SYSTEM_ID = '9a04f079-9840-4286-ab92-e65be0885f95';

/** Pulls the license blob out of a PlayReady SOAP response, or passes bytes through. */
export function unwrapPlayReadyResponse(response: ArrayBuffer): ArrayBuffer | Uint8Array {
  const text = new TextDecoder().decode(response);
  if (!text.includes('<License>')) return response;
  const match = /<License>([\s\S]*?)<\/License>/.exec(text);
  if (match === null) return response;
  const binary = atob((match[1] as string).trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function emeCenc(): Stage {
  return {
    name: 'eme-cenc',
    provides: ['eme-cenc'],
    requires: ['eme-core'],
    install() {
      // Widevine: the CDM message is the license request; the server
      // returns the license bytes to apply verbatim.
      registerKeySystem({
        keySystem: 'com.widevine.alpha',
        systemIds: [WIDEVINE_SYSTEM_ID],
        initDataTypes: ['cenc'],
        robustness: ['SW_SECURE_CRYPTO', ''],
        buildLicenseRequest: (message) => message,
        parseLicenseResponse: (response) => response,
      });
      // PlayReady: the CDM emits an XML challenge; the server answers with
      // a SOAP envelope carrying the license inside <License>.
      registerKeySystem({
        keySystem: 'com.microsoft.playready',
        systemIds: [PLAYREADY_SYSTEM_ID],
        initDataTypes: ['cenc'],
        robustness: ['3000', ''],
        licenseHeaders: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
        },
        buildLicenseRequest: (message) => message,
        parseLicenseResponse: unwrapPlayReadyResponse,
      });
      // Handlers are pure config in the shared registry; nothing to tear down.
      return undefined;
    },
  };
}
