/**
 * Huawei WisePlay over Common Encryption, a key system beside Widevine,
 * PlayReady and FairPlay. Like eme-cenc, it does not drive EME itself: it
 * registers a handler that eme-core negotiates and runs.
 *
 * WisePlay is built on the ChinaDRM standard and uses its system id, which
 * Shaka Player also maps to `com.huawei.wiseplay`. A DASH ContentProtection
 * and an HLS KEYFORMAT name it as `urn:uuid:3d5e6d35-...`, and the parsers
 * already carry that id to eme-core. The CDM's message is the license
 * request, and the server answers with the license bytes, as for Widevine.
 *
 * Two key system strings: Huawei's support names `com.huawei.wiseplay`, and
 * a HarmonyOS report (shaka-player#8185) needed `com.wiseplay.drm`. Each is
 * a handler, so eme-core asks for the first and falls back to the second.
 *
 * LG webOS TVs and Huawei devices have the CDM. No desktop browser does, so
 * the tests run against a stand-in for EME, not against a real CDM.
 */
import type { Stage } from '../../types/stage.js';
import { registerKeySystem } from '../drm-shared.js';

/** ChinaDRM's system id, which WisePlay signals. */
export const WISEPLAY_SYSTEM_ID = '3d5e6d35-9b9a-41e8-b843-dd3c6e72c42c';

/** The key system strings, in the order eme-core asks for them. */
export const WISEPLAY_KEY_SYSTEMS = ['com.huawei.wiseplay', 'com.wiseplay.drm'] as const;

/** The WisePlay handlers for eme-core, under both key system strings. */
export default function emeWiseplay(): Stage {
  return {
    name: 'eme-wiseplay',
    provides: ['eme-wiseplay'],
    requires: ['eme-core'],
    install() {
      // No robustness levels: WisePlay publishes no EME robustness strings,
      // so the request asks for none and the CDM uses its own.
      for (const keySystem of WISEPLAY_KEY_SYSTEMS) {
        registerKeySystem({
          keySystem,
          systemIds: [WISEPLAY_SYSTEM_ID],
          initDataTypes: ['cenc'],
          buildLicenseRequest: (message) => message,
          parseLicenseResponse: (response) => response,
        });
      }
      // The handler is pure config in the shared registry; nothing to tear down.
      return undefined;
    },
  };
}
