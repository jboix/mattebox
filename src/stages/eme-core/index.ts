/**
 * The generic EME handshake, entanglement #3 resolved: DRM lands without
 * touching a protocol adapter. Init data arrives by two routes — the
 * manifest (protection descriptors already in the IR since Stage 08) and
 * the media (the element's `encrypted` event) — and eme-core dedupes them
 * by key id so the same key never opens two sessions.
 *
 * Everything here is the impure edge: MediaKeys and MediaKeySession are
 * un-serializable and cannot enter the reducer, so this is an install-time
 * controller. It reports through ctx.emit (drm:* events, and a fatal
 * 'error' event that reaches engine.error) and exposes engine.drm; the
 * trace stays complete for everything the reducer can see.
 *
 * ClearKey is built in — it is the only key system testable headlessly.
 * Widevine, PlayReady, and FairPlay arrive as handlers eme-cenc and
 * eme-fairplay register through drm-shared.
 */
import type { ProtectionScheme } from '../../types/ir.js';
import type { Stage } from '../../types/stage.js';
import type { KeySystemHandler } from '../drm-shared.js';
import { keySystemHandlers, normalizeSystemId } from '../drm-shared.js';

export interface EmeOptions {
  /** License server URL, when the manifest does not carry one. */
  readonly licenseUrl?: string;
  /** Per-key-system license URLs, overriding `licenseUrl`. */
  readonly licenseUrls?: Readonly<Record<string, string>>;
  /** Rewrites the license request before it is sent (auth tokens, wrapping). */
  readonly requestFilter?: (body: Uint8Array, keySystem: string) => Uint8Array;
  /** For ClearKey tests: resolves a base64url key id to its base64url key. */
  readonly clearKeys?: Readonly<Record<string, string>>;
  /** Preference order among available key systems. */
  readonly preferredKeySystems?: readonly string[];
}

export interface DrmApi {
  readonly keySystem: string | null;
  readonly sessions: ReadonlyArray<{ readonly keyId: string; readonly status: string }>;
  /** Sets or replaces the license server URL at runtime. */
  setLicenseUrl(url: string): void;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    drm: DrmApi;
  }
}

const CLEARKEY = 'org.w3.clearkey';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A ClearKey handler: the license is a JSON the app answers from its keys. */
function clearKeyHandler(clearKeys: Readonly<Record<string, string>>): KeySystemHandler {
  return {
    keySystem: CLEARKEY,
    systemIds: ['1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'],
    initDataTypes: ['cenc', 'keyids'],
    // ClearKey needs no server: the license is produced from the keys here
    // and applied directly. eme-core skips the license POST for it.
    localLicense: true,
    buildLicenseRequest(message) {
      // The message is a JSON { kids: [base64url] }; answer with the keys.
      const request = JSON.parse(new TextDecoder().decode(message)) as { kids?: string[] };
      const keys = (request.kids ?? [])
        .filter((kid) => clearKeys[kid] !== undefined)
        .map((kid) => ({ kty: 'oct', kid, k: clearKeys[kid] as string }));
      return new TextEncoder().encode(JSON.stringify({ keys, type: 'temporary' }));
    },
    parseLicenseResponse(response) {
      return response;
    },
  };
}

/** The MSE capability config for requestMediaKeySystemAccess. */
function accessConfig(handler: KeySystemHandler): MediaKeySystemConfiguration[] {
  const robustnesses =
    handler.robustness && handler.robustness.length > 0 ? handler.robustness : [''];
  return robustnesses.map((robustness) => ({
    initDataTypes: [...handler.initDataTypes],
    videoCapabilities: [
      { contentType: 'video/mp4; codecs="avc1.42c01e"', robustness },
      { contentType: 'video/mp4; codecs="vp09.00.10.08"', robustness },
    ],
    audioCapabilities: [
      { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness },
      { contentType: 'audio/mp4; codecs="opus"', robustness },
    ],
  }));
}

export default function emeCore(options: EmeOptions = {}): Stage {
  return {
    name: 'eme-core',
    provides: ['eme-core'],
    requires: ['mse'],
    install(ctx) {
      const element = ctx.element;
      let mediaKeys: MediaKeys | null = null;
      let keySystem: string | null = null;
      let handler: KeySystemHandler | null = null;
      let licenseUrl = options.licenseUrl ?? null;
      // Dedup by key id: one session per key, whichever route delivered it.
      const sessionsByKey = new Map<string, MediaKeySession>();
      const statuses = new Map<string, string>();
      const initDataSeen = new Set<string>();
      let disposed = false;

      const api: DrmApi = {
        get keySystem() {
          return keySystem;
        },
        get sessions() {
          return [...statuses.entries()].map(([keyId, status]) => ({ keyId, status }));
        },
        setLicenseUrl(url) {
          licenseUrl = url;
        },
      };
      ctx.registerNamespace('drm', api);

      function fail(code: string, recoverable: boolean, cause?: unknown): void {
        ctx.emit('error', {
          category: 'drm',
          code,
          fatal: !recoverable,
          recoverable,
          ...(cause !== undefined ? { context: { message: String(cause) } } : {}),
        });
      }

      /** All handlers eme-core can use: ClearKey plus whatever registered. */
      function allHandlers(): KeySystemHandler[] {
        const registered = keySystemHandlers();
        const clearKeys = options.clearKeys;
        return clearKeys !== undefined
          ? [clearKeyHandler(clearKeys), ...registered]
          : [...registered];
      }

      /** Chooses and initializes a key system for the given systemIds. */
      async function ensureKeys(preferredSystemIds: readonly string[]): Promise<boolean> {
        if (mediaKeys !== null) return true;
        const handlers = allHandlers();
        const ordered = options.preferredKeySystems
          ? [...handlers].sort(
              (a, b) =>
                (options.preferredKeySystems as readonly string[]).indexOf(a.keySystem) -
                (options.preferredKeySystems as readonly string[]).indexOf(b.keySystem),
            )
          : handlers;
        // Prefer a handler that serves one of the manifest's systemIds.
        const candidates =
          preferredSystemIds.length > 0
            ? ordered.filter((h) => h.systemIds.some((id) => preferredSystemIds.includes(id)))
            : ordered;
        for (const candidate of candidates.length > 0 ? candidates : ordered) {
          try {
            const access = await navigator.requestMediaKeySystemAccess(
              candidate.keySystem,
              accessConfig(candidate),
            );
            const keys = await access.createMediaKeys();
            if (disposed) return false;
            if (candidate.fairplay?.certificateUrl !== undefined) {
              const cert = await ctx
                .request(candidate.fairplay.certificateUrl, {})
                .then((r) => r.arrayBuffer());
              await keys.setServerCertificate(cert);
            }
            await element.setMediaKeys(keys);
            mediaKeys = keys;
            keySystem = candidate.keySystem;
            handler = candidate;
            ctx.emit('drm:keysystem', { keySystem });
            return true;
          } catch {
            // Try the next candidate.
          }
        }
        fail('DRM_KEY_SYSTEM_UNAVAILABLE', false);
        return false;
      }

      /** Opens a session for one init data blob, deduped by key id. */
      async function openSession(initDataType: string, initData: ArrayBuffer): Promise<void> {
        if (mediaKeys === null || handler === null || disposed) return;
        const fingerprint = `${initDataType}:${bytesToBase64Url(new Uint8Array(initData))}`;
        if (initDataSeen.has(fingerprint)) return;
        initDataSeen.add(fingerprint);
        let session: MediaKeySession;
        try {
          session = mediaKeys.createSession('temporary');
        } catch (err) {
          fail('DRM_SESSION_FAILED', false, err);
          return;
        }
        session.addEventListener('message', (event) => {
          void onMessage(session, event as MediaKeyMessageEvent);
        });
        session.addEventListener('keystatuseschange', () => onKeyStatus(session));
        try {
          await session.generateRequest(initDataType, initData);
        } catch (err) {
          fail('DRM_INIT_DATA_INVALID', false, err);
        }
      }

      async function onMessage(
        session: MediaKeySession,
        event: MediaKeyMessageEvent,
      ): Promise<void> {
        if (handler === null) return;
        try {
          let body = handler.buildLicenseRequest(event.message);
          // ClearKey and other local systems need no round trip.
          if (handler.localLicense === true) {
            await session.update(body instanceof Uint8Array ? new Uint8Array(body) : body);
            return;
          }
          if (options.requestFilter !== undefined) {
            body = options.requestFilter(new Uint8Array(body), keySystem ?? '');
          }
          const url = options.licenseUrls?.[keySystem ?? ''] ?? licenseUrl;
          if (url === null || url === undefined) {
            fail('DRM_LICENSE_FAILED', false, 'no license url');
            return;
          }
          const response = await ctx.request(url, {
            method: 'POST',
            headers: { ...handler.licenseHeaders },
            body,
          });
          if (!response.ok) {
            fail('DRM_LICENSE_FAILED', true, `status ${response.status}`);
            return;
          }
          const raw = handler.parseLicenseResponse(await response.arrayBuffer());
          await session.update(raw instanceof Uint8Array ? new Uint8Array(raw) : raw);
        } catch (err) {
          fail('DRM_LICENSE_FAILED', true, err);
        }
      }

      function onKeyStatus(session: MediaKeySession): void {
        session.keyStatuses.forEach((status, keyIdBuffer) => {
          const keyId = bytesToBase64Url(new Uint8Array(keyIdBuffer as ArrayBuffer));
          statuses.set(keyId, status);
          sessionsByKey.set(keyId, session);
          ctx.emit('drm:keystatus', { keyId, status });
          if (status === 'expired') fail('DRM_KEY_EXPIRED', true);
          else if (status === 'output-restricted') fail('DRM_OUTPUT_RESTRICTED', false);
          else if (status === 'internal-error') fail('DRM_KEY_STATUS_ERROR', false);
        });
      }

      // The media route: the element fires `encrypted` with init data.
      const onEncrypted = (event: Event): void => {
        const e = event as MediaEncryptedEvent;
        if (e.initData === null) return;
        void ensureKeys([]).then((ok) => {
          if (ok) void openSession(e.initDataType, e.initData as ArrayBuffer);
        });
      };
      element.addEventListener('encrypted', onEncrypted);

      // The manifest route: the reducer emits protection descriptors on
      // MANIFEST_LOADED. Both routes converge on the same dedup.
      const offManifest = ctx.on('presentation:protection', (payload) => {
        const schemes = payload as readonly ProtectionScheme[];
        const systemIds = schemes
          .map((s) => normalizeSystemId(s.systemId))
          .filter((id): id is string => id !== null);
        void ensureKeys(systemIds).then((ok) => {
          if (!ok) return;
          for (const scheme of schemes) {
            if (scheme.initData !== null && scheme.initDataType !== null) {
              void openSession(scheme.initDataType, scheme.initData);
            }
          }
        });
      });

      return () => {
        disposed = true;
        element.removeEventListener('encrypted', onEncrypted);
        offManifest();
        for (const session of sessionsByKey.values()) void session.close().catch(() => {});
        void element.setMediaKeys(null).catch(() => {});
      };
    },
  };
}
